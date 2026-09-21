package main

import (
	"fmt"
	"html/template"
	"net/http"
)

func (g *gateway) loginPage(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>KKSS sign in</title><style>body{font:18px system-ui;max-width:32em;margin:10vh auto;padding:1em}input,button{display:block;margin:1em 0;padding:.7em}</style><h1>KKSS</h1><form method="post" action="%s/auth/login"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button>Sign in</button></form>`, template.HTMLEscapeString(g.base))
	if g.oauth != nil {
		fmt.Fprintf(w, `<a href="%s/auth/oidc">Sign in with your organization</a>`, template.HTMLEscapeString(g.base))
	}
}
func (g *gateway) desktopPage(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>KKSS</title><style>body{margin:0;background:#20242b;color:white;font:16px system-ui}nav{height:40px;display:flex;gap:20px;align-items:center;padding:0 12px}a{color:white}#screen{height:calc(100vh - 40px)}button{cursor:pointer}</style><nav><strong>KKSS</strong><a id="files" target="_blank" rel="noopener">Files</a><button id="logout">Sign out</button><span id="status">Connecting…</span></nav><div id="screen"></div><script type="module">
const base=location.pathname.replace(/\/$/,'');
const session=await fetch(base+'/api/session').then(r=>r.json());
document.querySelector('#files').href=base+'/files/';
document.querySelector('#logout').onclick=async()=>{await fetch(base+'/auth/logout',{method:'POST',headers:{'X-CSRF-Token':session.csrf}});location.href=base+'/auth/login'};
const {default:RFB}=await import(base+'/novnc/core/rfb.js');
let stopped=false;
async function connect(){
 const response=await fetch(base+'/api/bootstrap');if(response.status===401){location.href=base+'/auth/login';return}if(!response.ok){setTimeout(connect,3000);return}
 const config=await response.json();const ws=new URL(base+'/websockify',location.href);ws.protocol=location.protocol==='https:'?'wss:':'ws:';
 const rfb=new RFB(document.querySelector('#screen'),ws.href,{credentials:{password:config.password}});rfb.scaleViewport=true;rfb.resizeSession=true;
 rfb.addEventListener('connect',()=>document.querySelector('#status').textContent='Connected');
 rfb.addEventListener('disconnect',()=>{document.querySelector('#status').textContent='Reconnecting…';if(!stopped)setTimeout(connect,3000)});
 window.addEventListener('pagehide',()=>{stopped=true;rfb.disconnect()},{once:true});
}connect();</script>`)
}
