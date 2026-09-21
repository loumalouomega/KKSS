package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayRequiresLoginAndIssuesSession(t *testing.T) {
	t.Setenv("KKSS_PUBLIC_URL", "http://localhost:6080")
	t.Setenv("KKSS_AUTH_USERS", "ci:$2a$10$bEzSzT1YxBCO6YbLDlsEEu3xfDTB.ufafYDCmj.DAlCP6dC73T6MS")
	t.Setenv("KKSS_OIDC_ISSUER", "")
	t.Setenv("KKSS_IDLE_TIMEOUT", "0")
	g, err := newGateway()
	if err != nil {
		t.Fatal(err)
	}
	unauthorized := httptest.NewRecorder()
	g.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "http://localhost:6080/", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d", unauthorized.Code)
	}
	form := httptest.NewRequest(http.MethodPost, "http://localhost:6080/auth/login", strings.NewReader("username=ci&password=password"))
	form.Header.Set("Origin", "http://localhost:6080")
	form.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	logged := httptest.NewRecorder()
	g.ServeHTTP(logged, form)
	if logged.Code != http.StatusSeeOther || len(logged.Result().Cookies()) != 1 {
		t.Fatalf("login response = %d with %d cookies", logged.Code, len(logged.Result().Cookies()))
	}
	request := httptest.NewRequest(http.MethodGet, "http://localhost:6080/api/session", nil)
	request.AddCookie(logged.Result().Cookies()[0])
	authenticated := httptest.NewRecorder()
	g.ServeHTTP(authenticated, request)
	if authenticated.Code != http.StatusOK {
		t.Fatalf("authenticated status = %d", authenticated.Code)
	}
}

func TestGatewayRejectsForgedIdentityHeader(t *testing.T) {
	t.Setenv("KKSS_PUBLIC_URL", "http://localhost:6080")
	t.Setenv("KKSS_AUTH_USERS", "ci:$2a$10$bEzSzT1YxBCO6YbLDlsEEu3xfDTB.ufafYDCmj.DAlCP6dC73T6MS")
	t.Setenv("KKSS_OIDC_ISSUER", "")
	g, err := newGateway()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "http://localhost:6080/api/session", nil)
	req.Header.Set("X-Forwarded-User", "admin")
	res := httptest.NewRecorder()
	g.ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("forged identity status = %d", res.Code)
	}
}
