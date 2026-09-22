package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type instance struct {
	ID, Owner, Token, Container, Files string
	Workspace, Userdata, FilesVolume   string
	Running                            bool
}
type broker struct {
	kube                              *kubernetes
	mu                                sync.Mutex
	sessions                          map[string]*instance
	client                            *http.Client
	state, image, filesImage, network string
	perUser, total                    int
}

func newBroker() (*broker, error) {
	filesImage := os.Getenv("KKSS_FILES_IMAGE")
	if filesImage == "" {
		filesImage = "kkss-files:local"
	}
	b := &broker{sessions: map[string]*instance{}, state: env("KKSS_BROKER_STATE", "/data/sessions.json"), image: env("KKSS_SESSION_IMAGE", "ghcr.io/loumalouomega/kkss:2.0.0"), filesImage: filesImage, network: env("KKSS_SESSION_NETWORK", "kkss-sessions")}
	var e error
	b.perUser, e = strconv.Atoi(env("KKSS_USER_CAP", "1"))
	if e != nil || b.perUser < 1 {
		return nil, errors.New("invalid user cap")
	}
	b.total, e = strconv.Atoi(env("KKSS_GLOBAL_CAP", "10"))
	if e != nil || b.total < 1 {
		return nil, errors.New("invalid global cap")
	}
	b.client = &http.Client{Timeout: 45 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", env("KKSS_DOCKER_SOCKET", "/var/run/docker.sock"))
	}}}
	if os.Getenv("KKSS_BACKEND") == "kubernetes" {
		if os.Getenv("KKSS_FILES_IMAGE") == "" {
			b.filesImage = "filebrowser/filebrowser:v2.63.23"
		}
		b.kube, e = newKubernetes()
		if e != nil {
			return nil, e
		}
	}
	data, e := os.ReadFile(b.state)
	if e == nil {
		if json.Unmarshal(data, &b.sessions) != nil {
			return nil, errors.New("invalid broker state; refusing to allocate replacement sessions")
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	// Never dispatch before Docker is reachable and every recorded container has been reconciled.
	for _, s := range b.sessions {
		if e = validateVolumes(s); e != nil {
			return nil, e
		}
		if e = b.reconcile(s); e != nil {
			return nil, e
		}
	}
	return b, b.persist()
}
func (b *broker) docker(method, p string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, e := json.Marshal(body)
		if e != nil {
			return e
		}
		reader = strings.NewReader(string(data))
	}
	req, _ := http.NewRequest(method, "http://docker/v1.45"+p, reader)
	req.Header.Set("Content-Type", "application/json")
	res, e := b.client.Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(res.Body, 8192))
		return fmt.Errorf("Docker %s %s: status %d", method, p, res.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(out)
	}
	return nil
}
func (b *broker) persist() error {
	if e := os.MkdirAll(filepath.Dir(b.state), 0700); e != nil {
		return e
	}
	data, e := json.Marshal(b.sessions)
	if e != nil {
		return e
	}
	f, e := os.OpenFile(b.state+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(data)
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(b.state+".tmp", b.state); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(b.state))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func (b *broker) reconcile(s *instance) error {
	if b.kube != nil {
		return b.kube.reconcile(s)
	}
	var all []struct {
		ID     string `json:"Id"`
		State  string
		Labels map[string]string
	}
	filters := url.QueryEscape(`{"label":["kkss.session=` + s.ID + `"]}`)
	if e := b.docker("GET", "/containers/json?all=1&filters="+filters, nil, &all); e != nil {
		return e
	}
	s.Container = ""
	s.Files = ""
	s.Running = false
	for _, c := range all {
		if c.Labels["kkss.owner"] != ownerKey(s.Owner) {
			return errors.New("session owner label mismatch")
		}
		if c.Labels["kkss.role"] == "desktop" {
			if s.Container != "" {
				return errors.New("duplicate desktop container")
			}
			s.Container = c.ID
			s.Running = c.State == "running"
		} else if c.Labels["kkss.role"] == "files" {
			if s.Files != "" {
				return errors.New("duplicate file container")
			}
			s.Files = c.ID
		}
	}
	return nil
}
func ownerKey(owner string) string {
	sum := sha256.Sum256([]byte(owner))
	return hex.EncodeToString(sum[:])
}
func validateVolumes(s *instance) error {
	expected := map[*string]string{
		&s.Workspace:   "kkss-" + s.ID + "-workspace",
		&s.Userdata:    "kkss-" + s.ID + "-userdata",
		&s.FilesVolume: "kkss-" + s.ID + "-files",
	}
	for value, want := range expected {
		if *value != "" && *value != want {
			return errors.New("session volume name does not match its session ID")
		}
	}
	return nil
}
func (b *broker) createContainer(s *instance, role string, body map[string]any) (string, error) {
	body["Labels"] = map[string]string{"kkss.session": s.ID, "kkss.owner": ownerKey(s.Owner), "kkss.role": role}
	var result struct {
		ID string `json:"Id"`
	}
	e := b.docker("POST", "/containers/create?name=kkss-"+s.ID+"-"+role, body, &result)
	return result.ID, e
}
func (b *broker) start(s *instance, g *gateway) error {
	if e := validateVolumes(s); e != nil {
		return e
	}
	// Called under the allocation lock. Reconcile all records so caps count actual running containers.
	active, user := 0, 0
	for _, v := range b.sessions {
		if e := b.reconcile(v); e != nil {
			return e
		}
		if v.Running {
			active++
			if v.Owner == s.Owner {
				user++
			}
		}
	}
	if s.Running {
		return nil
	}
	if active >= b.total || user >= b.perUser {
		return errors.New("session capacity reached")
	}
	if b.kube != nil {
		return b.kube.start(b, s, g)
	}
	network := map[string]any{b.network: map[string]any{}}
	host := func(binds []string) map[string]any {
		return map[string]any{"Binds": binds, "NetworkMode": b.network, "Memory": 4 * 1024 * 1024 * 1024, "NanoCpus": 2 * 1000000000, "PidsLimit": 512, "ShmSize": 1024 * 1024 * 1024, "CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges:true"}, "RestartPolicy": map[string]string{"Name": "no"}}
	}
	workspace := "kkss-" + s.ID + "-workspace"
	userdata := "kkss-" + s.ID + "-userdata"
	filesVolume := "kkss-" + s.ID + "-files"
	if s.Workspace == "" {
		s.Workspace = workspace
	}
	if s.Userdata == "" {
		s.Userdata = userdata
	}
	if s.FilesVolume == "" {
		s.FilesVolume = filesVolume
	}
	workspace, userdata, filesVolume = s.Workspace, s.Userdata, s.FilesVolume
	if s.Container == "" {
		vars := []string{"KKSS_INTERNAL_TOKEN=" + s.Token, "KKSS_PUBLIC_URL=" + g.public, "KKSS_BASE_PATH=" + g.base + "/s/" + s.ID, "KKSS_IDLE_TIMEOUT=" + env("KKSS_SESSION_IDLE_TIMEOUT", "1800"), "KKSS_PROJECT_ROOT=/workspace", "KKSS_FILES_URL=http://kkss-" + s.ID + "-files:8080", "KKSS_TLS_TERMINATED=1"}
		// Only administrator-selected configuration enters child environments.
		for _, key := range []string{"KKSS_LLM_PROVIDER", "KKSS_LLM_MODEL", "KKSS_LLM_BASE_URL", "KKSS_RESTORE_SESSION", "KKSS_THEME", "KKSS_UI_THEME", "KKSS_ZOOM"} {
			if value := os.Getenv(key); value != "" {
				vars = append(vars, key+"="+value)
			}
		}
		var e error
		s.Container, e = b.createContainer(s, "desktop", map[string]any{"Image": b.image, "User": "1000:1000", "Env": vars, "HostConfig": host([]string{workspace + ":/workspace", userdata + ":/home/kkss/.config/kkss"}), "NetworkingConfig": map[string]any{"EndpointsConfig": network}})
		if e != nil {
			return e
		}
		if e = b.persist(); e != nil {
			return e
		}
	}
	if s.Files == "" {
		// The image's /workspace volume initializes ownership before this companion starts.
		var e error
		s.Files, e = b.createContainer(s, "files", map[string]any{"Image": b.filesImage, "User": "1000:1000", "Env": []string{"KKSS_BASE_PATH=" + g.base + "/s/" + s.ID}, "HostConfig": host([]string{workspace + ":/srv", filesVolume + ":/database"}), "NetworkingConfig": map[string]any{"EndpointsConfig": network}})
		if e != nil {
			return e
		}
		if e = b.persist(); e != nil {
			return e
		}
	}
	if e := b.docker("POST", "/containers/"+s.Files+"/start", nil, nil); e != nil {
		return e
	}
	if e := b.docker("POST", "/containers/"+s.Container+"/start", nil, nil); e != nil {
		return e
	}
	s.Running = true
	return b.persist()
}
func (b *broker) serve(w http.ResponseWriter, r *http.Request, g *gateway, auth *session, p string) {
	if p == "/" && r.Method == "GET" {
		brokerPage(w)
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if p == "/api/sessions" {
		if r.Method == "GET" {
			out := []map[string]any{}
			for _, s := range b.sessions {
				if s.Owner == auth.User {
					if e := b.reconcile(s); e != nil {
						http.Error(w, "Reconciliation unavailable", 503)
						return
					}
					out = append(out, map[string]any{"id": s.ID, "running": s.Running})
				}
			}
			writeJSON(w, out)
			return
		}
		if r.Method == "POST" {
			// Bound stopped records as well; each owner reuses their persistent session by default.
			count := 0
			for _, s := range b.sessions {
				if s.Owner == auth.User {
					count++
				}
			}
			if count >= b.perUser {
				http.Error(w, "Session limit reached; restart an existing session", 409)
				return
			}
			id := hex.EncodeToString([]byte(randomToken()))[:24]
			s := &instance{ID: id, Owner: auth.User, Token: randomToken()}
			b.sessions[id] = s
			if e := b.persist(); e != nil {
				delete(b.sessions, id)
				http.Error(w, "Cannot persist session", 500)
				return
			}
			if e := b.start(s, g); e != nil {
				http.Error(w, "Session could not start; inspect broker logs and retry", 503)
				return
			}
			writeJSON(w, map[string]string{"id": id})
			return
		}
		w.WriteHeader(405)
		return
	}
	if strings.HasPrefix(p, "/api/sessions/") {
		parts := strings.Split(strings.TrimPrefix(p, "/api/sessions/"), "/")
		if len(parts) != 2 || r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		s := b.sessions[parts[0]]
		if s == nil || s.Owner != auth.User {
			http.NotFound(w, r)
			return
		}
		var e error
		switch parts[1] {
		case "start":
			e = b.start(s, g)
		case "stop":
			e = b.reconcile(s)
			if e == nil && s.Running {
				if b.kube != nil {
					e = b.kube.stop(s)
				} else {
					e = b.docker("POST", "/containers/"+s.Container+"/stop?t=40", nil, nil)
				}
			}
			if e == nil && s.Files != "" {
				_ = b.docker("POST", "/containers/"+s.Files+"/stop?t=10", nil, nil)
			}
			s.Running = false
			if e == nil {
				e = b.persist()
			}
		default:
			http.NotFound(w, r)
			return
		}
		if e != nil {
			http.Error(w, "Session action failed", 503)
			return
		}
		w.WriteHeader(204)
		return
	}
	if !strings.HasPrefix(p, "/s/") {
		http.NotFound(w, r)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(p, "/s/"), "/", 2)
	if len(parts) != 2 {
		http.Redirect(w, r, r.URL.Path+"/", 302)
		return
	}
	s := b.sessions[parts[0]]
	if s == nil || s.Owner != auth.User {
		http.NotFound(w, r)
		return
	}
	if parts[1] == "api/session" {
		writeJSON(w, map[string]string{"user": auth.User, "csrf": auth.CSRF})
		return
	}
	if parts[1] == "auth/logout" && r.Method == "POST" {
		id, _ := g.current(r)
		g.revoke(id)
		g.cookie(w, "kkss_session", "", -1)
		w.WriteHeader(204)
		return
	}
	if parts[1] == "auth/login" {
		http.Redirect(w, r, g.base+"/auth/login", 302)
		return
	}
	if e := b.start(s, g); e != nil {
		http.Error(w, "Session unavailable; retry from session list", 503)
		return
	}
	hostname := "kkss-" + s.ID + "-desktop"
	if b.kube != nil {
		hostname = "kkss-" + s.ID
	}
	target, _ := url.Parse("http://" + hostname + ":6080")
	token := s.Token
	// Release allocation lock during long-lived streams.
	b.mu.Unlock()
	defer b.mu.Lock()
	proxy := httputil.NewSingleHostReverseProxy(target)
	original := proxy.Director
	proxy.Director = func(req *http.Request) {
		original(req)
		req.Header.Del("Cookie")
		req.Header.Set("Authorization", "Bearer "+token)
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) {
		http.Error(w, "Session starting; retry shortly", 503)
	}
	id, _ := g.current(r)
	proxy.ServeHTTP(trackingWriter{w, g, id}, r)
}
func brokerPage(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>KKSS sessions</title><style>body{font:18px system-ui;margin:3em}button,a{margin:1em}</style><h1>Your KKSS sessions</h1><button id="create">Create session</button><button id="logout">Sign out</button><p id="error"></p><div id="sessions"></div><script type="module">
const base=location.pathname.replace(/\/$/,'');const auth=await fetch(base+'/api/session').then(r=>r.json());
async function action(url){const r=await fetch(base+url,{method:'POST',headers:{'X-CSRF-Token':auth.csrf}});if(!r.ok){document.querySelector('#error').textContent=await r.text();return false}return true}
async function refresh(){const rows=await fetch(base+'/api/sessions').then(r=>r.json());const root=document.querySelector('#sessions');root.replaceChildren();for(const row of rows){const div=document.createElement('div'),link=document.createElement('a'),stop=document.createElement('button');link.href=base+'/s/'+row.id+'/';link.textContent=row.id+(row.running?' (running)':' (stopped)');stop.textContent='Stop';stop.onclick=async()=>{await action('/api/sessions/'+row.id+'/stop');refresh()};div.append(link,stop);root.append(div)}}
document.querySelector('#create').onclick=async()=>{await action('/api/sessions');refresh()};document.querySelector('#logout').onclick=async()=>{if(await action('/auth/logout'))location.reload()};refresh();</script>`)
}
