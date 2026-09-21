package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type kubernetes struct {
	client            *http.Client
	origin, namespace string
}

func newKubernetes() (*kubernetes, error) {
	ca, e := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
	if e != nil {
		return nil, e
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return nil, errors.New("invalid Kubernetes CA")
	}
	ns, e := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
	if e != nil {
		return nil, e
	}
	return &kubernetes{client: &http.Client{Timeout: 45 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}}, origin: "https://" + env("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc") + ":" + env("KUBERNETES_SERVICE_PORT", "443"), namespace: strings.TrimSpace(string(ns))}, nil
}
func (k *kubernetes) call(method, resource string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, e := json.Marshal(body)
		if e != nil {
			return e
		}
		reader = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, k.origin+"/api/v1/namespaces/"+k.namespace+"/"+resource, reader)
	token, e := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Content-Type", "application/json")
	res, e := k.client.Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		if method == "POST" && res.StatusCode == 409 {
			return nil
		}
		if method == "DELETE" && res.StatusCode == 404 {
			return nil
		}
		return fmt.Errorf("Kubernetes %s %s: %d", method, resource, res.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(out)
	}
	return nil
}
func (k *kubernetes) reconcile(s *instance) error {
	var pods struct {
		Items []struct {
			Metadata struct {
				Name   string
				Labels map[string]string
			}
			Status struct {
				ContainerStatuses []struct {
					Name  string
					State struct{ Running *struct{} }
				}
			}
		}
	}
	if e := k.call("GET", "pods?labelSelector="+url.QueryEscape("kkss.session="+s.ID), nil, &pods); e != nil {
		return e
	}
	if len(pods.Items) > 1 {
		return errors.New("duplicate session pods")
	}
	s.Running = false
	s.Container = ""
	s.Files = ""
	for _, p := range pods.Items {
		if p.Metadata.Labels["kkss.owner"] != ownerKey(s.Owner) {
			return errors.New("session owner label mismatch")
		}
		s.Container = p.Metadata.Name
		for _, c := range p.Status.ContainerStatuses {
			if c.Name == "desktop" && c.State.Running != nil {
				s.Running = true
			}
		}
	}
	return nil
}
func (k *kubernetes) stop(s *instance) error {
	return k.call("DELETE", "pods/kkss-"+s.ID, map[string]any{"gracePeriodSeconds": 40}, nil)
}
func (k *kubernetes) start(b *broker, s *instance, g *gateway) error {
	if e := validateVolumes(s); e != nil {
		return e
	}
	name := "kkss-" + s.ID
	if s.Workspace == "" {
		s.Workspace = name + "-workspace"
	}
	if s.Userdata == "" {
		s.Userdata = name + "-userdata"
	}
	if s.FilesVolume == "" {
		s.FilesVolume = name + "-files"
	}
	labels := map[string]string{"kkss.session": s.ID, "kkss.owner": ownerKey(s.Owner)}
	meta := func(n string) map[string]any { return map[string]any{"name": n, "labels": labels} }
	// Reuse PVCs/Secrets; never delete them on stop. Names derive only from persisted random IDs.
	for _, volume := range []string{s.Workspace, s.Userdata, s.FilesVolume} {
		if e := k.call("POST", "persistentvolumeclaims", map[string]any{"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": meta(volume), "spec": map[string]any{"accessModes": []string{"ReadWriteOnce"}, "resources": map[string]any{"requests": map[string]string{"storage": env("KKSS_SESSION_STORAGE", "10Gi")}}}}, nil); e != nil {
			return e
		}
	}
	if e := k.call("POST", "secrets", map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": meta(name), "stringData": map[string]string{"token": s.Token}}, nil); e != nil {
		return e
	}
	if e := k.call("POST", "services", map[string]any{"apiVersion": "v1", "kind": "Service", "metadata": meta(name), "spec": map[string]any{"selector": map[string]string{"kkss.session": s.ID}, "ports": []any{map[string]any{"port": 6080, "targetPort": 6080}}}}, nil); e != nil {
		return e
	}
	if s.Container != "" {
		if e := k.stop(s); e != nil {
			return e
		}
		return errors.New("previous pod is stopping; retry shortly")
	}
	vars := []any{map[string]any{"name": "KKSS_INTERNAL_TOKEN", "valueFrom": map[string]any{"secretKeyRef": map[string]string{"name": name, "key": "token"}}}}
	for key, value := range map[string]string{"KKSS_PUBLIC_URL": g.public, "KKSS_BASE_PATH": g.base + "/s/" + s.ID, "KKSS_IDLE_TIMEOUT": env("KKSS_SESSION_IDLE_TIMEOUT", "1800"), "KKSS_PROJECT_ROOT": "/workspace", "KKSS_FILES_URL": "http://127.0.0.1:8080", "KKSS_TLS_TERMINATED": "1"} {
		vars = append(vars, map[string]string{"name": key, "value": value})
	}
	for _, key := range []string{"KKSS_LLM_PROVIDER", "KKSS_LLM_MODEL", "KKSS_LLM_BASE_URL", "KKSS_RESTORE_SESSION", "KKSS_THEME", "KKSS_ZOOM"} {
		if v := os.Getenv(key); v != "" {
			vars = append(vars, map[string]string{"name": key, "value": v})
		}
	}
	volumes := []any{}
	for _, volume := range []struct{ name, claim string }{{"workspace", s.Workspace}, {"userdata", s.Userdata}, {"files", s.FilesVolume}} {
		volumes = append(volumes, map[string]any{"name": volume.name, "persistentVolumeClaim": map[string]string{"claimName": volume.claim}})
	}
	security := map[string]any{"allowPrivilegeEscalation": false, "capabilities": map[string]any{"drop": []string{"ALL"}}, "seccompProfile": map[string]string{"type": "RuntimeDefault"}}
	resources := map[string]any{"limits": map[string]string{"cpu": "2", "memory": "4Gi"}, "requests": map[string]string{"cpu": "250m", "memory": "512Mi"}}
	pod := map[string]any{"apiVersion": "v1", "kind": "Pod", "metadata": meta(name), "spec": map[string]any{"automountServiceAccountToken": false, "restartPolicy": "Never", "terminationGracePeriodSeconds": 40, "securityContext": map[string]any{"runAsUser": 1000, "runAsGroup": 1000, "runAsNonRoot": true, "fsGroup": 1000}, "volumes": volumes, "containers": []any{
		map[string]any{"name": "desktop", "image": b.image, "env": vars, "securityContext": security, "resources": resources, "volumeMounts": []any{map[string]string{"name": "workspace", "mountPath": "/workspace"}, map[string]string{"name": "userdata", "mountPath": "/home/kkss/.config/kkss"}}, "readinessProbe": map[string]any{"httpGet": map[string]any{"path": "/healthz", "port": 6080}, "initialDelaySeconds": 10}},
		map[string]any{"name": "files", "image": b.filesImage, "args": []string{"--database", "/database/filebrowser.db", "--root", "/srv", "--address", "0.0.0.0", "--port", "8080", "--baseURL", g.base + "/s/" + s.ID + "/files", "--auth.method", "proxy", "--auth.header", "X-Remote-User", "--disableExec", "true", "--followExternalSymlinks", "false", "--perm.execute", "false", "--perm.share", "false", "--perm.admin", "false"}, "env": []any{map[string]string{"name": "KKSS_BASE_PATH", "value": g.base + "/s/" + s.ID}}, "securityContext": security, "resources": resources, "volumeMounts": []any{map[string]string{"name": "workspace", "mountPath": "/srv"}, map[string]string{"name": "files", "mountPath": "/database"}}},
	}}}
	if e := k.call("POST", "pods", pod, nil); e != nil {
		return e
	}
	s.Container = name
	s.Running = true
	return b.persist()
}
