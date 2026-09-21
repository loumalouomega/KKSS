package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// JSON output avoids interpreting operator input as Caddyfile syntax.
func caddyConfig() error {
	u, e := url.Parse(env("KKSS_PUBLIC_URL", "http://localhost:6080"))
	if e != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("invalid public URL")
	}
	upstream := env("KKSS_GATEWAY_UPSTREAM", "127.0.0.1:6082")
	proxy := map[string]any{"handler": "reverse_proxy", "upstreams": []any{map[string]any{"dial": upstream}}}
	handlers := []any{proxy}
	server := map[string]any{"listen": []string{":" + env("NOVNC_PORT", "6080")}, "routes": []any{map[string]any{"handle": handlers}}}
	httpApp := map[string]any{"servers": map[string]any{"web": server}, "http_port": 6080, "https_port": 6443}
	apps := map[string]any{"http": httpApp}
	if u.Scheme == "https" {
		server["listen"] = []string{":6443"}
		server["tls_connection_policies"] = []any{map[string]any{}}
		server["routes"] = []any{map[string]any{"match": []any{map[string]any{"host": []string{u.Hostname()}}}, "handle": []any{map[string]any{"handler": "headers", "response": map[string]any{"set": map[string]any{"Strict-Transport-Security": []string{"max-age=31536000"}}}}, proxy}}}
		cert, key := os.Getenv("KKSS_TLS_CERT"), os.Getenv("KKSS_TLS_KEY")
		if (cert == "") != (key == "") {
			return fmt.Errorf("both TLS certificate and key are required")
		}
		tls := map[string]any{}
		if cert != "" {
			tls["certificates"] = map[string]any{"load_files": []any{map[string]any{"certificate": cert, "key": key}}}
		} else {
			tls["automation"] = map[string]any{"policies": []any{map[string]any{"subjects": []string{u.Hostname()}, "issuers": []any{map[string]any{"module": "acme"}}}}}
		}
		apps["tls"] = tls
	}
	if os.Getenv("KKSS_TLS_TERMINATED") == "1" {
		delete(server, "tls_connection_policies")
		server["listen"] = []string{":" + env("NOVNC_PORT", "6080")}
		delete(apps, "tls")
		server["automatic_https"] = map[string]any{"disable": true}
	}
	// Only configured external proxies may supply client IPs; never trust arbitrary forwarded headers.
	if peers := os.Getenv("KKSS_TRUSTED_PROXIES"); peers != "" {
		server["trusted_proxies"] = map[string]any{"source": "static", "ranges": strings.Split(peers, ",")}
		server["trusted_proxies_strict"] = true
	}
	port, e := strconv.Atoi(env("NOVNC_PORT", "6080"))
	if e != nil || port < 1024 || port > 65535 {
		return fmt.Errorf("NOVNC_PORT must be unprivileged")
	}
	config := map[string]any{"admin": map[string]any{"disabled": true}, "apps": apps}
	return json.NewEncoder(os.Stdout).Encode(config)
}
