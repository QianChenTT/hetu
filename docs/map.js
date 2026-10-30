(function(){
"use strict";
var SVGNS="http://www.w3.org/2000/svg";

/* ---------- helpers ---------- */
function $(id){return document.getElementById(id)}
function el(tag,attrs,parent){var e=document.createElementNS(SVGNS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);if(parent)parent.appendChild(e);return e}
function h(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
var byId={};N.forEach(function(n){byId[n.id]=n});ZONES.forEach(function(z){byId[z.id]=z});
var edgeById={};E.forEach(function(e){edgeById[e.id]=e});
function nameOf(id){var o=byId[id];if(!o)return id;return o.l?o.l[0]:o.label}
function clsOf(id){var o=byId[id];return o?o.cls:"core"}
function center(r){return {x:r.x+r.w/2,y:r.y+r.h/2}}
function clip(r,from,to){
  var dx=to.x-from.x,dy=to.y-from.y,t=1;
  if(dx!==0){var tx=dx>0?(r.x+r.w-from.x)/dx:(r.x-from.x)/dx;if(tx>0&&tx<t)t=tx}
  if(dy!==0){var ty=dy>0?(r.y+r.h-from.y)/dy:(r.y-from.y)/dy;if(ty>0&&ty<t)t=ty}
  return {x:from.x+dx*t,y:from.y+dy*t};
}

/* ---------- build svg ---------- */
var svg=$("map"),gZ=$("zones"),gE=$("edges"),gN=$("nodes"),gL=$("labels"),gD=$("dots");
ZONES.forEach(function(z){
  var g=el("g",{"class":"zone z-"+z.cls},gZ);
  el("rect",{x:z.x,y:z.y,width:z.w,height:z.h,rx:10},g);
  var t=el("text",{x:z.x+12,y:z.y+17},g);t.textContent=z.label;
});
var pathEls={};
E.forEach(function(e,i){
  var a=byId[e.f],b=byId[e.t];
  var ca=center(a),cb=center(b);
  var p1=clip(a,ca,cb),p2=clip(b,cb,ca);
  var mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2,dx=p2.x-p1.x,dy=p2.y-p1.y,len=Math.sqrt(dx*dx+dy*dy)||1;
  var bend=(e.bend!=null?e.bend:((i%3)-1)*10);
  var cx=mx-dy/len*bend,cy=my+dx/len*bend;
  var d="M"+p1.x.toFixed(1)+" "+p1.y.toFixed(1)+" Q"+cx.toFixed(1)+" "+cy.toFixed(1)+" "+p2.x.toFixed(1)+" "+p2.y.toFixed(1);
  var g=el("g",{"class":"edge"+(e.kind?" "+e.kind:""),"data-id":e.id},gE);
  var p=el("path",{d:d,"marker-end":e.kind==="att"?"url(#arrAtt)":"url(#arr)"},g);
  var hit=el("path",{d:d,"class":"hit",tabindex:"-1"},g);
  var tt=el("title",{},hit);tt.textContent=nameOf(e.f)+" → "+nameOf(e.t)+": "+e.l;
  pathEls[e.id]={g:g,p:p};
  hit.addEventListener("click",function(ev){ev.stopPropagation();selectEdge(e.id)});
});
var nodeEls={};
N.forEach(function(n){
  var g=el("g",{"class":"node n-"+n.cls+(n.key?" key":""),"data-id":n.id,tabindex:"0",role:"button","aria-label":n.l.join(" ")+(n.sub.length?" — "+n.sub.join(", "):"")},gN);
  el("rect",{x:n.x,y:n.y,width:n.w,height:n.h,rx:6},g);
  var lines=n.l.length+n.sub.length,lh=14,top=n.y+n.h/2-((lines-1)*lh)/2+4;
  var t=el("text",{x:n.x+n.w/2,y:top,"text-anchor":"middle"},g);
  n.l.forEach(function(s,i){var ts=el("tspan",{x:n.x+n.w/2,dy:i===0?0:lh},t);ts.textContent=s});
  n.sub.forEach(function(s,i){var ts=el("tspan",{x:n.x+n.w/2,dy:lh,"class":"sub"},t);ts.textContent=s});
  nodeEls[n.id]=g;
  g.addEventListener("click",function(ev){ev.stopPropagation();selectNode(n.id)});
  g.addEventListener("keydown",function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();selectNode(n.id)}});
  g.addEventListener("mouseenter",function(){if(mode==="explore"&&!pinned)preview(n.id)});
  g.addEventListener("mouseleave",function(){if(mode==="explore"&&!pinned)clearHi()});
});
svg.addEventListener("click",function(){if(mode==="explore"){pinned=null;clearHi();renderIntro()}});

/* marker colors via CSS vars */
function paintMarkers(){
  var cs=getComputedStyle(document.documentElement);
  svg.querySelector("#arr path").setAttribute("fill",cs.getPropertyValue("--muted").trim());
  svg.querySelector("#arrOn path").setAttribute("fill",cs.getPropertyValue("--accent").trim());
  svg.querySelector("#arrAtt path").setAttribute("fill",cs.getPropertyValue("--danger").trim());
}
paintMarkers();
if(window.matchMedia){var mq=window.matchMedia("(prefers-color-scheme: dark)");if(mq.addEventListener)mq.addEventListener("change",paintMarkers)}
new MutationObserver(paintMarkers).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});

/* ---------- highlight ---------- */
var mode="explore",pinned=null,scen=null,stepIx=0,anim=null;
var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function clearHi(){
  svg.classList.remove("dim");
  Object.keys(nodeEls).forEach(function(k){nodeEls[k].classList.remove("on","sel")});
  Object.keys(pathEls).forEach(function(k){var o=pathEls[k];o.g.classList.remove("on");o.p.setAttribute("marker-end",edgeById[k].kind==="att"?"url(#arrAtt)":"url(#arr)")});
  gL.replaceChildren();stopDots();
}
function hi(nodes,edges,sel){
  clearHi();svg.classList.add("dim");
  nodes.forEach(function(id){if(nodeEls[id])nodeEls[id].classList.add("on")});
  if(sel&&nodeEls[sel])nodeEls[sel].classList.add("sel");
  edges.forEach(function(id){var o=pathEls[id];if(!o)return;o.g.classList.add("on");o.p.setAttribute("marker-end",edgeById[id].kind==="att"?"url(#arrAtt)":"url(#arrOn)");addLabel(id)});
  if(mode==="scenario"&&!reduce)startDots(edges);
}
function addLabel(id){
  var o=pathEls[id],e=edgeById[id],len=o.p.getTotalLength(),pt=o.p.getPointAtLength(len/2);
  var g=el("g",{"class":"elabel"+(e.kind==="att"?" att":"")},gL);
  var r=el("rect",{},g),t=el("text",{x:pt.x,y:pt.y+4,"text-anchor":"middle"},g);t.textContent=e.l;
  var bb=t.getBBox();r.setAttribute("x",bb.x-5);r.setAttribute("y",bb.y-2);r.setAttribute("width",bb.width+10);r.setAttribute("height",bb.height+4);
}
function edgesOf(id){return E.filter(function(e){return e.f===id||e.t===id||(byId[id]&&byId[id].zone&&(e.f===byId[id].zone||e.t===byId[id].zone))})}
function preview(id){
  var es=edgesOf(id),ns=[id];
  es.forEach(function(e){[e.f,e.t].forEach(function(x){if(nodeEls[x]&&ns.indexOf(x)<0)ns.push(x)})});
  hi(ns,es.map(function(e){return e.id}),id);
}
function stopDots(){if(anim){cancelAnimationFrame(anim);anim=null}gD.replaceChildren()}
function startDots(edges){
  stopDots();if(!edges.length)return;
  var dots=edges.map(function(id){var e=edgeById[id];return {p:pathEls[id].p,len:pathEls[id].p.getTotalLength(),c:el("circle",{r:4.5,"class":"dot"+(e.kind==="att"?" att":"")},gD)}});
  var t0=null;
  function frame(ts){if(t0==null)t0=ts;var k=((ts-t0)%1600)/1600;
    dots.forEach(function(d){var pt=d.p.getPointAtLength(d.len*k);d.c.setAttribute("cx",pt.x);d.c.setAttribute("cy",pt.y)});
    anim=requestAnimationFrame(frame)}
  anim=requestAnimationFrame(frame);
}

/* ---------- panel ---------- */
var panel=$("panel");
function tagList(arr,cls,fmt){var w=h("div","tags");arr.forEach(function(x){var s=h("span","tag "+cls,fmt?fmt(x):x);if(cls==="threat")s.title=TH[x]||"";w.appendChild(s)});return w}
function threatFmt(x){return TH[x]||""}
function renderIntro(){
  panel.replaceChildren();
  panel.appendChild(h("span","eyebrow","How to read it"));
  panel.appendChild(h("h2",null,"Pick a box, an arrow or a scenario"));
  var p=h("p",null,"The daemon in the middle-left holds all power. Everything in teal is sandboxed and can only ask the capability gate. The hardware key store on the right keeps you in the loop: hetu's security state only changes with a prompt you approve.");p.style.color="var(--muted)";panel.appendChild(p);
  var ul=h("ul");["Hover a box to light up every flow it has","Click to pin it and read its role, checks and threats","Choose a scenario above to step through a sequence","Every flow is also listed in the table below the map"].forEach(function(s){ul.appendChild(h("li",null,s))});panel.appendChild(ul);
  panel.appendChild(h("span","eyebrow","Counts"));
  var m=h("p",null,N.length+" components · "+E.length+" flows · "+S.length+" scenarios");m.className="mono";panel.appendChild(m);
}
function renderNode(id){
  var n=byId[id];panel.replaceChildren();
  var k=h("span","eyebrow kind");k.appendChild(h("span","pill "+n.cls,({core:"Trusted core",sandbox:"Sandboxed",outside:"Outside hetu",disk:"Disk and OS",proc:"Outside the sandbox"})[n.cls]));panel.appendChild(k);
  panel.appendChild(h("h2",null,n.l.join(" ")));
  if(n.sub.length){var s=h("p",null,n.sub.join(" · "));s.style.color="var(--muted)";panel.appendChild(s)}
  panel.appendChild(h("p",null,n.role));
  var dl=h("dl","meta");dl.appendChild(h("dt",null,"Runs in"));dl.appendChild(h("dd",null,n.where));dl.appendChild(h("dt",null,"Trust"));dl.appendChild(h("dd",null,n.trust));panel.appendChild(dl);
  panel.appendChild(h("h3",null,"What it does"));var ul=h("ul");n.does.forEach(function(x){ul.appendChild(h("li",null,x))});panel.appendChild(ul);
  if(n.dec.length){panel.appendChild(h("h3",null,"Design decisions"));panel.appendChild(tagList(n.dec,"dec"))}
  if(n.th.length){panel.appendChild(h("h3",null,"Threats it covers"));panel.appendChild(tagList(n.th,"threat",threatFmt))}
  var es=edgesOf(id);panel.appendChild(h("h3",null,"Flows ("+es.length+")"));
  var fl=h("ul");es.forEach(function(e){var li=h("li");var b=h("button","","");b.style.cssText="background:none;border:0;padding:0;color:var(--accent);text-align:left;font-size:14px";b.textContent=(e.f===id||e.f===n.zone?"→ "+nameOf(e.t):"← "+nameOf(e.f))+": "+e.l;b.addEventListener("click",function(){selectEdge(e.id)});li.appendChild(b);fl.appendChild(li)});panel.appendChild(fl);
}
function renderEdge(id){
  var e=edgeById[id];panel.replaceChildren();
  var k=h("span","eyebrow",e.kind==="att"?"Attack attempt":e.kind==="opt"?"Optional flow":"Flow");panel.appendChild(k);
  panel.appendChild(h("h2",null,e.l));
  var dl=h("dl","meta");dl.appendChild(h("dt",null,"From"));var a=h("dd");a.appendChild(h("span","pill "+clsOf(e.f),nameOf(e.f)));dl.appendChild(a);
  dl.appendChild(h("dt",null,"To"));var b=h("dd");b.appendChild(h("span","pill "+clsOf(e.t),nameOf(e.t)));dl.appendChild(b);panel.appendChild(dl);
  panel.appendChild(h("h3",null,"Checked by"));var ul=h("ul");e.chk.forEach(function(x){ul.appendChild(h("li",null,x))});panel.appendChild(ul);
  if(e.th.length){panel.appendChild(h("h3",null,"Threats it covers"));panel.appendChild(tagList(e.th,"threat",threatFmt))}
  var inS=S.filter(function(s){return s.steps.some(function(st){return st.e.indexOf(id)>=0})});
  if(inS.length){panel.appendChild(h("h3",null,"Appears in"));var w=h("div","tags");inS.forEach(function(s){var bt=h("button","chipbtn",s.name);bt.addEventListener("click",function(){startScenario(s.id)});w.appendChild(bt)});panel.appendChild(w)}
}
function renderStep(){
  var s=scen,st=s.steps[stepIx];panel.replaceChildren();
  panel.appendChild(h("span","eyebrow","Scenario"));
  panel.appendChild(h("h2",null,s.name));
  var sm=h("p",null,s.sum);sm.style.color="var(--muted)";panel.appendChild(sm);
  var nav=h("div","stepnav");
  var prev=h("button","btn","Previous");prev.disabled=stepIx===0;prev.addEventListener("click",function(){go(stepIx-1)});
  var next=h("button","btn primary",stepIx===s.steps.length-1?"Finish":"Next step");next.addEventListener("click",function(){if(stepIx===s.steps.length-1)endScenario();else go(stepIx+1)});
  var cnt=h("span","count","Step "+(stepIx+1)+" of "+s.steps.length);
  nav.appendChild(prev);nav.appendChild(next);nav.appendChild(cnt);panel.appendChild(nav);
  panel.appendChild(h("h3",null,(stepIx+1)+". "+st.t));
  panel.appendChild(h("p",null,st.x));
  if(st.c.length){var o=h("div","outcome"+(st.bad?" bad":""));o.appendChild(h("strong",null,st.bad?"Attempt · ":"Checks · "));o.appendChild(document.createTextNode(st.c.join(" · ")));panel.appendChild(o)}
  if(st.th.length){panel.appendChild(tagList(st.th,"threat",threatFmt))}
  var ol=h("ol","steplist");s.steps.forEach(function(x,i){var li=h("li");var b=h("button");b.appendChild(h("span","mono",String(i+1)));b.appendChild(h("span",null,x.t));if(i===stepIx)b.setAttribute("aria-current","step");b.addEventListener("click",function(){go(i)});li.appendChild(b);ol.appendChild(li)});panel.appendChild(ol);
  var ex=h("button","btn","Back to exploring");ex.addEventListener("click",function(){endScenario()});panel.appendChild(ex);
}

/* ---------- modes ---------- */
function selectNode(id){if(mode==="scenario")endScenario(true);pinned=id;preview(id);renderNode(id)}
function selectEdge(id){if(mode==="scenario")endScenario(true);pinned=id;var e=edgeById[id];var ns=[e.f,e.t].filter(function(x){return nodeEls[x]});hi(ns,[id]);renderEdge(id);}
function setScenButtons(){document.querySelectorAll("#scenButtons button").forEach(function(b){b.setAttribute("aria-pressed",String(scen&&b.dataset.id===scen.id))});$("exploreBtn").setAttribute("aria-pressed",String(mode==="explore"))}
function startScenario(id){mode="scenario";pinned=null;scen=S.filter(function(s){return s.id===id})[0];stepIx=0;setScenButtons();go(0);
  try{localStorage.setItem("hetuMapScen",id)}catch(_){}
  if(window.innerWidth<1100)$("mapbox").scrollIntoView({behavior:reduce?"auto":"smooth",block:"start"});}
function go(i){stepIx=Math.max(0,Math.min(i,scen.steps.length-1));var st=scen.steps[stepIx];hi(st.n,st.e);renderStep()}
function endScenario(silent){mode="explore";scen=null;clearHi();setScenButtons();if(!silent)renderIntro();try{localStorage.removeItem("hetuMapScen")}catch(_){}}
document.addEventListener("keydown",function(ev){if(mode!=="scenario")return;var tag=(ev.target.tagName||"").toLowerCase();if(tag==="input"||tag==="select")return;
  if(ev.key==="ArrowRight"){ev.preventDefault();go(stepIx+1)}else if(ev.key==="ArrowLeft"){ev.preventDefault();go(stepIx-1)}else if(ev.key==="Escape")endScenario()});

var sb=$("scenButtons");
S.forEach(function(s){var b=h("button","chipbtn",s.name);b.dataset.id=s.id;b.setAttribute("aria-pressed","false");b.title=s.sum;b.addEventListener("click",function(){startScenario(s.id)});sb.appendChild(b)});
$("exploreBtn").addEventListener("click",function(){endScenario()});

/* ---------- flows table ---------- */
var sel=$("flowFilter");
N.slice().sort(function(a,b){return nameOf(a.id).localeCompare(nameOf(b.id))}).forEach(function(n){var o=document.createElement("option");o.value=n.id;o.textContent=n.l.join(" ");sel.appendChild(o)});
ZONES.forEach(function(z){if(z.id==="zHidden"){var o=document.createElement("option");o.value=z.id;o.textContent="Hidden plugin renderer (all its plugins)";sel.appendChild(o)}});
function renderFlows(){
  var f=sel.value,q=$("flowSearch").value.trim().toLowerCase(),tb=$("flowRows");tb.replaceChildren();var count=0;
  E.forEach(function(e){
    if(f){var z=byId[f]&&byId[f].zone;if(!(e.f===f||e.t===f||(z&&(e.f===z||e.t===z))))return}
    var hay=(nameOf(e.f)+" "+nameOf(e.t)+" "+e.l+" "+e.chk.join(" ")+" "+e.th.map(function(x){return TH[x]||""}).join(" ")).toLowerCase();
    if(q&&hay.indexOf(q)<0)return;
    count++;
    var tr=h("tr","flowrow");tr.tabIndex=0;
    var a=h("td");a.appendChild(h("span","pill "+clsOf(e.f),nameOf(e.f)));tr.appendChild(a);
    var b=h("td");b.appendChild(h("span","pill "+clsOf(e.t),nameOf(e.t)));tr.appendChild(b);
    var c=h("td");c.appendChild(h("strong",null,e.l));if(e.kind==="att")c.appendChild(h("div","tag threat","attack attempt"));if(e.kind==="opt")c.appendChild(h("div","tag","optional"));tr.appendChild(c);
    var d=h("td");var ul=h("ul");ul.style.cssText="margin:0;padding-left:16px";e.chk.forEach(function(x){ul.appendChild(h("li",null,x))});d.appendChild(ul);tr.appendChild(d);
    var t=h("td");t.appendChild(tagList(e.th,"threat",threatFmt));tr.appendChild(t);
    function open(){selectEdge(e.id);$("mapbox").scrollIntoView({behavior:reduce?"auto":"smooth",block:"start"})}
    tr.addEventListener("click",open);tr.addEventListener("keydown",function(ev){if(ev.key==="Enter")open()});
    tb.appendChild(tr);
  });
  $("flowCount").textContent=count+" of "+E.length+" flows shown. Click a row to see it on the map.";
}
sel.addEventListener("change",renderFlows);$("flowSearch").addEventListener("input",renderFlows);renderFlows();

/* ---------- components ---------- */
var pg=$("partGroups");
ZONES.forEach(function(z){
  var ns=N.filter(function(n){return n.zone===z.id});if(!ns.length)return;
  var g=h("div","zonegroup");var hd=h("h3");hd.appendChild(h("span","pill "+z.cls,z.label));g.appendChild(hd);
  var grid=h("div","grid-cards");
  ns.forEach(function(n){var c=h("div","card");c.appendChild(h("h3",null,n.l.join(" ")));if(n.sub.length){var s=h("p",null,n.sub.join(" · "));c.appendChild(s)}
    var r=h("p",null,n.role);r.style.color="var(--ink)";c.appendChild(r);
    var b=h("button","link","Show on map");b.addEventListener("click",function(){selectNode(n.id);$("mapbox").scrollIntoView({behavior:reduce?"auto":"smooth",block:"start"})});c.appendChild(b);grid.appendChild(c)});
  g.appendChild(grid);pg.appendChild(g);
});

/* ---------- arrow switch ---------- */
var arrowSwitch=$("arrowSwitch");
function setArrows(on){svg.classList.toggle("arrows-off",!on);arrowSwitch.checked=on}
arrowSwitch.addEventListener("change",function(){setArrows(arrowSwitch.checked);try{localStorage.setItem("hetuMapArrows",arrowSwitch.checked?"on":"off")}catch(_){}});
var savedArrows=null;try{savedArrows=localStorage.getItem("hetuMapArrows")}catch(_){}
setArrows(savedArrows==="on");

/* ---------- start ---------- */
renderIntro();
var saved=null;try{saved=localStorage.getItem("hetuMapScen")}catch(_){}
if(location.hash&&S.some(function(s){return s.id===location.hash.slice(1)}))startScenario(location.hash.slice(1));
else if(saved&&S.some(function(s){return s.id===saved}))startScenario(saved);
})();
