package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func sample(version string, seq int64) manifest {
	refs := images{}
	for _, s := range services {
		refs[s] = "ghcr.io/ralitej/youplayer-server-" + s + "@sha256:" + strings.Repeat("a", 64)
	}
	return manifest{3, 1, 1, true, version, strings.Repeat("b", 40), seq, map[string]images{"linux/amd64": refs, "linux/arm64": refs}}
}
func signed(t *testing.T, m manifest, key ed25519.PrivateKey) envelope {
	t.Helper()
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return envelope{base64.StdEncoding.EncodeToString(data), base64.StdEncoding.EncodeToString(ed25519.Sign(key, data))}
}
func keys(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func TestManifest(t *testing.T) {
	pub, priv := keys(t)
	e := signed(t, sample("v1.0.0", 1), priv)
	_, err := verifyManifest(e, pub)
	must(t, err)
	changes := []func(*manifest){func(m *manifest) { m.Contract = 2 }, func(m *manifest) { m.DataVersion = 2 }, func(m *manifest) { m.RollbackCompatible = false }, func(m *manifest) { delete(m.Platforms, "linux/arm64") }, func(m *manifest) { m.Platforms["linux/amd64"]["backend"] = "evil@sha256:" + strings.Repeat("a", 64) }, func(m *manifest) { m.Version = "v1.0.0-beta" }, func(m *manifest) { m.Sequence = 9007199254740992 }, func(m *manifest) {
		m.Platforms["linux/arm64"]["frontend"] = "ghcr.io/ralitej/youplayer-server-frontend:latest"
	}}
	for i, change := range changes {
		m := sample("v1.0.0", 1)
		change(&m)
		if _, err = verifyManifest(signed(t, m, priv), pub); err == nil {
			t.Fatalf("mutation %d accepted", i)
		}
	}
	e.Payload = signed(t, sample("v2.0.0", 2), priv).Payload
	if _, err = verifyManifest(e, pub); code(err) != "invalid-signature" {
		t.Fatal(err)
	}
	if compareVersions("v100000000000000000000.0.0", "v2.0.0") != 1 {
		t.Fatal("version overflow")
	}
}

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(body any) *http.Response {
	data, _ := json.Marshal(body)
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}
}
func TestReleaseSource(t *testing.T) {
	pub, priv := keys(t)
	calls := 0
	e := signed(t, sample("v1.0.0", 1), priv)
	c := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return response(map[string]any{"draft": false, "prerelease": false, "tag_name": "v1.0.0", "assets": []any{map[string]string{"name": "youplayer-release.json", "url": "https://api.github.com/repos/RaliteJ/YouPlayer_Server/releases/assets/1"}}}), nil
		}
		return response(e), nil
	})}
	got, err := latest(c, pub)
	must(t, err)
	if got != e || calls != 2 {
		t.Fatal("source mismatch")
	}
	for _, location := range []string{"http://127.0.0.1/private", "https://evil.example/", "https://user@github.com/file", "https://github.com:444/file"} {
		calls = 0
		c.Transport = transport(func(r *http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{location}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		})
		_, err = latest(c, pub)
		if code(err) != "download-origin" || calls != 1 {
			t.Fatalf("foreign redirect: %s %v %d", location, err, calls)
		}
	}
	c.Transport = transport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 1024*1024+1)))}, nil
	})
	_, err = latest(c, pub)
	if code(err) != "invalid-release" {
		t.Fatal(err)
	}
}
