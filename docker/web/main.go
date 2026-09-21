// KKSS deployment gateway. The desktop and viewer bundles remain unmodified.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/oauth2"
)

type session struct {
	User, CSRF string
	Expires    time.Time
	Streams    map[net.Conn]bool
}
type attempt struct {
	Count int
	Until time.Time
}
type oidcAttempt struct {
	Verifier, Nonce string
	Expires         time.Time
}
type gateway struct {
	mu                                   sync.Mutex
	users                                map[string][]byte
	sessions                             map[string]*session
	attempts                             map[string]attempt
	flows                                map[string]oidcAttempt
	base, public, vnc, control, internal string
	secure                               bool
	oauth                                *oauth2.Config
	verifier                             *oidc.IDTokenVerifier
	emails, groups                       map[string]bool
	broker                               *broker
	idle                                 time.Duration
	idleSince                            time.Time
	streams                              int
}

func randomToken() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func secret(k string) (string, error) {
	v, f := os.Getenv(k), os.Getenv(k+"_FILE")
	if v != "" && f != "" {
		return "", fmt.Errorf("%s and its file conflict", k)
	}
	if f != "" {
		b, e := os.ReadFile(f)
		if e != nil {
			return "", fmt.Errorf("cannot read %s_FILE", k)
		}
		v = strings.TrimSpace(string(b))
	}
	return v, nil
}
func csv(s string) map[string]bool {
	m := map[string]bool{}
	for _, v := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == '\n' || r == ';' }) {
		if v = strings.TrimSpace(v); v != "" {
			m[v] = true
		}
	}
	return m
}
func newGateway() (*gateway, error) {
	g := &gateway{users: map[string][]byte{}, sessions: map[string]*session{}, attempts: map[string]attempt{}, flows: map[string]oidcAttempt{}, base: os.Getenv("KKSS_BASE_PATH"), public: env("KKSS_PUBLIC_URL", "http://localhost:6080"), control: os.Getenv("KKSS_CONTROL_TOKEN"), internal: os.Getenv("KKSS_INTERNAL_TOKEN")}
	if g.base != "" && (g.base[0] != '/' || path.Clean(g.base) != g.base || strings.ContainsAny(g.base, "?#%\\")) {
		return nil, errors.New("invalid KKSS_BASE_PATH")
	}
	g.base = strings.TrimSuffix(g.base, "/")
	u, e := url.Parse(g.public)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid KKSS_PUBLIC_URL")
	}
	g.public = u.Scheme + "://" + u.Host
	g.secure = u.Scheme == "https"
	users, e := secret("KKSS_AUTH_USERS")
	if e != nil {
		return nil, e
	}
	for _, line := range strings.Split(users, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		name, hash, ok := strings.Cut(line, ":")
		cost, err := bcrypt.Cost([]byte(hash))
		if !ok || name == "" || strings.ContainsAny(name, " \t\r") || err != nil || cost < 10 || cost > 16 || g.users[name] != nil {
			return nil, errors.New("invalid or duplicate bcrypt user (cost 10–16 required)")
		}
		g.users[name] = []byte(hash)
	}
	if issuer := os.Getenv("KKSS_OIDC_ISSUER"); issuer != "" {
		clientSecret, err := secret("KKSS_OIDC_CLIENT_SECRET")
		if err != nil {
			return nil, err
		}
		id := os.Getenv("KKSS_OIDC_CLIENT_ID")
		if id == "" || clientSecret == "" {
			return nil, errors.New("OIDC client ID and secret required")
		}
		g.emails = csv(os.Getenv("KKSS_OIDC_ALLOWED_EMAILS"))
		g.groups = csv(os.Getenv("KKSS_OIDC_ALLOWED_GROUPS"))
		if len(g.emails)+len(g.groups) == 0 {
			return nil, errors.New("OIDC requires an email or group allowlist")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		provider, err := oidc.NewProvider(ctx, issuer)
		if err != nil {
			return nil, fmt.Errorf("OIDC discovery failed: %w", err)
		}
		g.oauth = &oauth2.Config{ClientID: id, ClientSecret: clientSecret, Endpoint: provider.Endpoint(), RedirectURL: g.public + g.base + "/auth/callback", Scopes: []string{oidc.ScopeOpenID, "profile", "email", "groups"}}
		g.verifier = provider.Verifier(&oidc.Config{ClientID: id})
	} else if os.Getenv("KKSS_OIDC_CLIENT_ID") != "" || os.Getenv("KKSS_OIDC_CLIENT_SECRET") != "" || os.Getenv("KKSS_OIDC_CLIENT_SECRET_FILE") != "" {
		return nil, errors.New("incomplete OIDC configuration")
	}
	if len(g.users) == 0 && g.oauth == nil && g.internal == "" {
		password := randomToken()
		hash, _ := bcrypt.GenerateFromPassword([]byte(password), 12)
		g.users["admin"] = hash
		log.Printf("Startup login: admin / %s at %s%s/ (valid until restart)", password, g.public, g.base)
	}
	if g.internal != "" && len(g.internal) < 32 {
		return nil, errors.New("internal token too short")
	}
	if f := os.Getenv("KKSS_VNC_PASSWORD_FILE"); f != "" {
		b, e := os.ReadFile(f)
		if e != nil {
			return nil, fmt.Errorf("cannot read internal VNC credential")
		}
		g.vnc = strings.TrimSpace(string(b))
		if g.vnc == "" {
			return nil, errors.New("internal VNC credential is empty")
		}
	}
	seconds, e := strconv.Atoi(env("KKSS_IDLE_TIMEOUT", "0"))
	if e != nil || seconds < 0 {
		return nil, errors.New("invalid idle timeout")
	}
	g.idle = time.Duration(seconds) * time.Second
	return g, nil
}
func (g *gateway) cookie(w http.ResponseWriter, name, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: g.base + "/", HttpOnly: true, Secure: g.secure, SameSite: http.SameSiteLaxMode, MaxAge: maxAge})
}
func (g *gateway) current(r *http.Request) (string, *session) {
	c, e := r.Cookie("kkss_session")
	if e != nil {
		return "", nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	s := g.sessions[c.Value]
	if s != nil && time.Now().Before(s.Expires) {
		return c.Value, s
	}
	return "", nil
}
func (g *gateway) issue(w http.ResponseWriter, user string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	id := randomToken()
	g.sessions[id] = &session{User: user, CSRF: randomToken(), Expires: time.Now().Add(12 * time.Hour), Streams: map[net.Conn]bool{}}
	g.cookie(w, "kkss_session", id, 43200)
}
func (g *gateway) revoke(id string) {
	g.mu.Lock()
	s := g.sessions[id]
	delete(g.sessions, id)
	var connections []net.Conn
	if s != nil {
		for c := range s.Streams {
			connections = append(connections, c)
		}
	}
	g.mu.Unlock()
	for _, c := range connections {
		c.Close()
	}
}
func (g *gateway) allowedLogin(r *http.Request) bool {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	g.mu.Lock()
	defer g.mu.Unlock()
	a := g.attempts[host]
	if time.Now().After(a.Until) {
		a = attempt{Until: time.Now().Add(5 * time.Minute)}
	}
	a.Count++
	g.attempts[host] = a
	return a.Count <= 10
}
func (g *gateway) sameOrigin(r *http.Request) bool { return r.Header.Get("Origin") == g.public }
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	if r.URL.Path == "/healthz" || (g.base != "" && r.URL.Path == g.base+"/healthz") {
		if r.Method != "GET" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
		return
	}
	if g.base != "" && r.URL.Path == g.base {
		http.Redirect(w, r, g.base+"/", http.StatusPermanentRedirect)
		return
	}
	if !strings.HasPrefix(r.URL.Path, g.base+"/") {
		http.NotFound(w, r)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, g.base)
	// Identity and forwarding headers are never accepted from browser input.
	for _, h := range []string{"X-Forwarded-User", "X-Auth-Request-User", "X-Remote-User", "X-Forwarded-Email", "Forwarded"} {
		r.Header.Del(h)
	}
	if p == "/auth/login" {
		if r.Method == "GET" {
			g.loginPage(w)
			return
		}
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		if !g.sameOrigin(r) {
			w.WriteHeader(403)
			return
		}
		if !g.allowedLogin(r) {
			w.WriteHeader(429)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if r.ParseForm() != nil {
			w.WriteHeader(400)
			return
		}
		hash := g.users[r.FormValue("username")]
		if len(hash) == 0 {
			hash = []byte("$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW")
		}
		err := bcrypt.CompareHashAndPassword(hash, []byte(r.FormValue("password")))
		if err != nil || g.users[r.FormValue("username")] == nil {
			http.Error(w, "Sign-in failed", 401)
			return
		}
		g.issue(w, "local:"+r.FormValue("username"))
		http.Redirect(w, r, g.base+"/", 303)
		return
	}
	if p == "/auth/oidc" || p == "/auth/callback" {
		g.oidc(w, r, p)
		return
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") && !g.sameOrigin(r) {
		w.WriteHeader(403)
		return
	}
	id, s := g.current(r)
	if g.internal != "" && r.Header.Get("Authorization") == "Bearer "+g.internal {
		s = &session{User: "broker", CSRF: g.internal, Streams: map[net.Conn]bool{}}
	}
	if s == nil {
		w.WriteHeader(401)
		g.loginPage(w)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		if r.Header.Get("Authorization") != "Bearer "+g.internal || g.internal == "" {
			if !g.sameOrigin(r) || (!strings.Contains(p, "/files/") && r.Header.Get("X-CSRF-Token") != s.CSRF) {
				w.WriteHeader(403)
				return
			}
		}
	}
	if p == "/auth/logout" && r.Method == "POST" {
		g.revoke(id)
		g.cookie(w, "kkss_session", "", -1)
		w.WriteHeader(204)
		return
	}
	if p == "/api/session" && r.Method == "GET" {
		writeJSON(w, map[string]any{"user": s.User, "csrf": s.CSRF})
		return
	}
	if g.broker != nil {
		g.broker.serve(w, r, g, s, p)
		return
	}
	switch {
	case p == "/" && r.Method == "GET":
		g.desktopPage(w)
	case p == "/api/bootstrap" && r.Method == "GET":
		writeJSON(w, map[string]string{"password": g.vnc, "base": g.base})
	case p == "/api/activity" && r.Method == "GET":
		a, e := g.activity()
		if e != nil {
			http.Error(w, "Activity unavailable", 503)
		} else {
			g.mu.Lock()
			a["connectedBrowsers"] = g.streams
			a["clients"] = g.streams
			g.mu.Unlock()
			writeJSON(w, a)
		}
	case strings.HasPrefix(p, "/files/"):
		target := os.Getenv("KKSS_FILES_URL")
		if target == "" {
			http.Error(w, "File service not configured", 503)
			return
		}
		r.Header.Set("X-Remote-User", "kkss")
		g.proxy(w, r, target, "", id)
	case strings.HasPrefix(p, "/novnc/"):
		g.proxy(w, r, "http://127.0.0.1:6081", g.base+"/novnc", id)
	case p == "/websockify":
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || (!g.sameOrigin(r) && g.internal == "") {
			w.WriteHeader(403)
			return
		}
		g.proxy(w, r, "http://127.0.0.1:6081", g.base, id)
	default:
		http.NotFound(w, r)
	}
}
func (g *gateway) oidc(w http.ResponseWriter, r *http.Request, p string) {
	if g.oauth == nil || r.Method != "GET" {
		http.NotFound(w, r)
		return
	}
	if p == "/auth/oidc" {
		if !g.allowedLogin(r) {
			w.WriteHeader(429)
			return
		}
		state := randomToken()
		flow := oidcAttempt{Verifier: oauth2.GenerateVerifier(), Nonce: randomToken(), Expires: time.Now().Add(5 * time.Minute)}
		g.mu.Lock()
		g.flows[state] = flow
		g.mu.Unlock()
		g.cookie(w, "kkss_oidc", state, 300)
		http.Redirect(w, r, g.oauth.AuthCodeURL(state, oidc.Nonce(flow.Nonce), oauth2.S256ChallengeOption(flow.Verifier)), 302)
		return
	}
	query := r.URL.Query()
	state := query.Get("state")
	c, e := r.Cookie("kkss_oidc")
	if e != nil || state == "" || len(query["state"]) != 1 || len(query["code"]) > 1 || c.Value != state {
		w.WriteHeader(403)
		return
	}
	g.mu.Lock()
	flow, ok := g.flows[state]
	delete(g.flows, state)
	g.mu.Unlock()
	g.cookie(w, "kkss_oidc", "", -1)
	if !ok || time.Now().After(flow.Expires) {
		w.WriteHeader(403)
		return
	}
	token, e := g.oauth.Exchange(r.Context(), r.URL.Query().Get("code"), oauth2.VerifierOption(flow.Verifier))
	if e != nil {
		http.Error(w, "Sign-in failed", 401)
		return
	}
	raw, _ := token.Extra("id_token").(string)
	verified, e := g.verifier.Verify(r.Context(), raw)
	if e != nil || verified.Nonce != flow.Nonce {
		w.WriteHeader(401)
		return
	}
	var claims struct {
		Email    string   `json:"email"`
		Verified bool     `json:"email_verified"`
		Groups   []string `json:"groups"`
	}
	if verified.Claims(&claims) != nil {
		w.WriteHeader(401)
		return
	}
	allowed := claims.Verified && g.emails[claims.Email]
	for _, group := range claims.Groups {
		allowed = allowed || g.groups[group]
	}
	if !allowed {
		w.WriteHeader(403)
		return
	}
	g.issue(w, "oidc:"+verified.Issuer+":"+verified.Subject)
	http.Redirect(w, r, g.base+"/", 303)
}

// Hijacked connections are tracked so logout/expiry closes existing streams too.
type trackedConn struct {
	net.Conn
	once sync.Once
	done func()
}

func (c *trackedConn) Close() error { err := c.Conn.Close(); c.once.Do(c.done); return err }

type trackingWriter struct {
	http.ResponseWriter
	g  *gateway
	id string
}

func (w trackingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("websocket upgrade is not supported by the upstream writer")
	}
	c, b, e := h.Hijack()
	if e != nil {
		return nil, nil, e
	}
	t := &trackedConn{Conn: c}
	t.done = func() {
		w.g.mu.Lock()
		defer w.g.mu.Unlock()
		w.g.streams--
		if s := w.g.sessions[w.id]; s != nil {
			delete(s.Streams, t)
		}
	}
	w.g.mu.Lock()
	w.g.streams++
	if s := w.g.sessions[w.id]; s != nil {
		s.Streams[t] = true
	}
	w.g.mu.Unlock()
	return t, b, nil
}

// Preserve streaming responses (downloads and reverse-proxy upgrades) while
// wrapping the writer for connection accounting.
func (w trackingWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (g *gateway) proxy(w http.ResponseWriter, r *http.Request, target, strip, id string) {
	u, e := url.Parse(target)
	if e != nil || u.Host == "" {
		w.WriteHeader(502)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	original := proxy.Director
	proxy.Director = func(req *http.Request) {
		original(req)
		req.URL.Path = strings.TrimPrefix(req.URL.Path, strip)
		req.URL.RawPath = ""
		req.Header.Del("Cookie")
		req.Header.Del("Authorization")
	}
	proxy.ErrorLog = log.New(io.Discard, "", 0)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) { http.Error(w, "Upstream unavailable", 502) }
	proxy.ServeHTTP(trackingWriter{w, g, id}, r)
}
func (g *gateway) activity() (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:"+env("KKSS_CONTROL_PORT", "6083")+"/activity", nil)
	req.Header.Set("Authorization", "Bearer "+g.control)
	res, e := http.DefaultClient.Do(req)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, errors.New("activity failed")
	}
	var a map[string]any
	e = json.NewDecoder(io.LimitReader(res.Body, 16384)).Decode(&a)
	return a, e
}
func (g *gateway) maintenance() {
	for range time.Tick(time.Second) {
		now := time.Now()
		g.mu.Lock()
		expired := []string{}
		for id, s := range g.sessions {
			if now.After(s.Expires) {
				expired = append(expired, id)
			}
		}
		for k, a := range g.attempts {
			if now.After(a.Until) {
				delete(g.attempts, k)
			}
		}
		for k, a := range g.flows {
			if now.After(a.Expires) {
				delete(g.flows, k)
			}
		}
		clients := g.streams
		g.mu.Unlock()
		for _, id := range expired {
			g.revoke(id)
		}
		if g.idle == 0 || g.broker != nil {
			continue
		}
		a, e := g.activity()
		safe := e == nil && a["ready"] == true && a["jobs"] == float64(0) && a["unknownJobs"] == false && a["uploads"] == false && a["shuttingDown"] == false && clients == 0
		if !safe {
			g.idleSince = time.Time{}
			continue
		}
		if g.idleSince.IsZero() {
			g.idleSince = now
		}
		if now.Sub(g.idleSince) < g.idle {
			continue
		}
		req, _ := http.NewRequest("POST", "http://127.0.0.1:"+env("KKSS_CONTROL_PORT", "6083")+"/shutdown", nil)
		req.Header.Set("Authorization", "Bearer "+g.control)
		client := http.Client{Timeout: 3 * time.Second}
		res, e := client.Do(req)
		if e == nil {
			res.Body.Close()
		}
		g.idleSince = now
	}
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "caddy-config" {
		if e := caddyConfig(); e != nil {
			log.Fatal(e)
		}
		return
	}
	g, e := newGateway()
	if e != nil {
		log.Fatal(e)
	}
	if os.Getenv("KKSS_BROKER") == "1" {
		g.broker, e = newBroker()
		if e != nil {
			log.Fatal(e)
		}
	}
	go g.maintenance()
	server := &http.Server{Addr: env("KKSS_GATEWAY_ADDR", "127.0.0.1:6082"), Handler: g, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second, MaxHeaderBytes: 16384}
	log.Fatal(server.ListenAndServe())
}
