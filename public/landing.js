/* ============================================================
   THREE.JS — HERO FORGE ORB
   ============================================================ */
(function(){
  const canvas = document.getElementById('hero-canvas');
  if(!canvas || typeof THREE === 'undefined') return;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth/window.innerHeight, 0.1, 100);
  camera.position.set(0,0,7);

  const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const group = new THREE.Group();
  scene.add(group);

  const coreGeo = new THREE.IcosahedronGeometry(1.35, 1);
  const coreMat = new THREE.MeshBasicMaterial({color:0x00e5ff, wireframe:true, transparent:true, opacity:0.55});
  const core = new THREE.Mesh(coreGeo, coreMat);
  group.add(core);

  const coreInnerGeo = new THREE.IcosahedronGeometry(1.0, 0);
  const coreInnerMat = new THREE.MeshBasicMaterial({color:0xff6b35, wireframe:true, transparent:true, opacity:0.3});
  const coreInner = new THREE.Mesh(coreInnerGeo, coreInnerMat);
  group.add(coreInner);

  function makeGlowTexture(hex){
    const c = document.createElement('canvas'); c.width=c.height=256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128,128,0,128,128,128);
    g.addColorStop(0, hex+'ff'); g.addColorStop(0.4, hex+'55'); g.addColorStop(1, hex+'00');
    ctx.fillStyle=g; ctx.fillRect(0,0,256,256);
    return new THREE.CanvasTexture(c);
  }
  const glowMat = new THREE.SpriteMaterial({map:makeGlowTexture('#00e5ff'), transparent:true, blending:THREE.AdditiveBlending, opacity:0.5});
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(6,6,1);
  group.add(glow);

  const PCOUNT = 500;
  const pGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(PCOUNT*3);
  const colors = new Float32Array(PCOUNT*3);
  const palette = [[0,0.9,1],[0.71,1,0.22],[1,0.42,0.21]];
  for(let i=0;i<PCOUNT;i++){
    const r = 2.4 + Math.random()*3.2;
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos((Math.random()*2)-1);
    positions[i*3] = r*Math.sin(phi)*Math.cos(theta);
    positions[i*3+1] = r*Math.sin(phi)*Math.sin(theta)*0.6;
    positions[i*3+2] = r*Math.cos(phi);
    const col = palette[Math.floor(Math.random()*palette.length)];
    colors[i*3]=col[0]; colors[i*3+1]=col[1]; colors[i*3+2]=col[2];
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(colors,3));
  const pMat = new THREE.PointsMaterial({size:0.035, vertexColors:true, transparent:true, opacity:0.85, blending:THREE.AdditiveBlending, depthWrite:false});
  const particles = new THREE.Points(pGeo, pMat);
  group.add(particles);

  const panels = [];
  const panelPositions = [
    [2.6, 0.9, -0.4], [-2.7, -0.6, 0.2], [0.3, -1.7, 1.0]
  ];
  panelPositions.forEach((pos, i)=>{
    const g = new THREE.Group();
    const w=1.15,h=0.78;
    const frameGeo = new THREE.PlaneGeometry(w,h);
    const edges = new THREE.EdgesGeometry(frameGeo);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({color:i===1?0xb4ff39:0x00e5ff, transparent:true, opacity:0.7}));
    g.add(line);
    for(let j=0;j<3;j++){
      const barGeo = new THREE.PlaneGeometry(w*0.7 - j*0.15, 0.05);
      const barMat = new THREE.MeshBasicMaterial({color:0x00e5ff, transparent:true, opacity:0.35});
      const bar = new THREE.Mesh(barGeo, barMat);
      bar.position.set(0, h/2 - 0.18 - j*0.16, 0.001);
      g.add(bar);
    }
    g.position.set(...pos);
    g.userData.baseY = pos[1];
    g.userData.speed = 0.4 + Math.random()*0.4;
    g.userData.offset = Math.random()*Math.PI*2;
    group.add(g);
    panels.push(g);
  });

  const connMat = new THREE.LineBasicMaterial({color:0x00e5ff, transparent:true, opacity:0.25});
  panels.forEach(p=>{
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), p.position]);
    const l = new THREE.Line(geo, connMat.clone());
    group.add(l);
  });

  let mouseX=0, mouseY=0, targetRotX=0, targetRotY=0;
  window.addEventListener('mousemove', (e)=>{
    mouseX = (e.clientX/window.innerWidth - 0.5);
    mouseY = (e.clientY/window.innerHeight - 0.5);
  });

  const clock = new THREE.Clock();
  function animate(){
    const t = clock.getElapsedTime();
    core.rotation.y = t*0.15;
    core.rotation.x = t*0.08;
    coreInner.rotation.y = -t*0.22;
    coreInner.rotation.x = t*0.1;
    particles.rotation.y = t*0.03;

    panels.forEach(p=>{
      p.position.y = p.userData.baseY + Math.sin(t*p.userData.speed + p.userData.offset)*0.18;
      p.rotation.y = Math.sin(t*0.3 + p.userData.offset)*0.25;
      p.rotation.x = Math.cos(t*0.25 + p.userData.offset)*0.1;
    });

    targetRotY += (mouseX*0.5 - targetRotY)*0.04;
    targetRotX += (mouseY*0.3 - targetRotX)*0.04;
    group.rotation.y = targetRotY;
    group.rotation.x = -targetRotX;

    camera.position.x += (mouseX*0.6 - camera.position.x)*0.03;
    camera.position.y += (-mouseY*0.4 - camera.position.y)*0.03;
    camera.lookAt(0,0,0);

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();

  window.addEventListener('resize', ()=>{
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  if(window.gsap && window.ScrollTrigger){
    gsap.registerPlugin(ScrollTrigger);
    gsap.to(canvas, {
      opacity:0.15, ease:'none',
      scrollTrigger:{trigger:'.hero', start:'top top', end:'bottom top', scrub:true}
    });
  }
})();

/* ============================================================
   GSAP SCROLL REVEALS + DEMO TYPING + INTEGRATIONS ORBIT
   ============================================================ */
(function(){
  if(typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return;
  gsap.registerPlugin(ScrollTrigger);

  document.querySelectorAll('.reveal').forEach((el)=>{
    gsap.to(el, {
      opacity:1, y:0, duration:0.9, ease:'power3.out',
      scrollTrigger:{trigger:el, start:'top 88%'}
    });
  });

  document.querySelectorAll('.feature-card').forEach((el,i)=>{
    gsap.to(el, {opacity:1, y:0, duration:0.7, delay:(i%3)*0.08, ease:'power3.out',
      scrollTrigger:{trigger:el, start:'top 90%'}});
  });

  document.querySelectorAll('.flow-step').forEach((el,i)=>{
    gsap.to(el, {opacity:1, y:0, duration:0.7, delay:i*0.12, ease:'power3.out',
      scrollTrigger:{trigger:el, start:'top 90%'}});
  });

  document.querySelectorAll('.price-card').forEach((el,i)=>{
    gsap.to(el, {opacity:1, y:0, duration:0.7, delay:i*0.1, ease:'power3.out',
      scrollTrigger:{trigger:el, start:'top 90%'}});
  });

  gsap.timeline({delay:0.6})
    .to('.build-log .ln', {opacity:1, duration:0.01, stagger:0.65});

  document.querySelectorAll('.feature-card').forEach(card=>{
    card.addEventListener('mousemove', (e)=>{
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX-r.left)+'px');
      card.style.setProperty('--my', (e.clientY-r.top)+'px');
    });
  });

  const codeLines = [
    {t:'prompt', text:'// prompt: '},
    {t:'raw', text:'"Portfolio site for a ceramics studio,\\n warm palette, shop + about + contact"\\n\\n'},
    {t:'k', text:'export default function '},
    {t:'fn', text:'Home'},
    {t:'raw', text:'() {\\n  return (\\n    '},
    {t:'tag', text:'&lt;Nav '},
    {t:'attr', text:'links={['},{t:'s', text:'"Shop","About","Contact"'},{t:'attr', text:']} /&gt;\\n    '},
    {t:'tag', text:'&lt;Hero\\n      '},
    {t:'attr', text:'title='},{t:'s', text:'"Handmade, fired slow."'},{t:'raw', text:'\\n      '},
    {t:'attr', text:'cta='},{t:'s', text:'"Shop the kiln"'},{t:'raw', text:' /&gt;\\n    '},
    {t:'tag', text:'&lt;FeaturedGrid '},{t:'attr', text:'items={3} /&gt;\\n    '},
    {t:'tag', text:'&lt;Footer /&gt;\\n  '},{t:'raw', text:');\\n}'}
  ];
  const el = document.getElementById('typecode');
  let full = '';
  codeLines.forEach(l=>{
    const cls = l.t==='raw'?'':` class="${ {k:'k',fn:'t',s:'s',prompt:'c',attr:'t',tag:'k'}[l.t] || '' }"`;
    full += `<span${cls}>${l.text}</span>`;
  });

  if(el){
    ScrollTrigger.create({
      trigger:'#demo',
      start:'top 60%',
      once:true,
      onEnter:()=>{
        const plain = full;
        const tmp = document.createElement('div'); tmp.innerHTML = plain;
        const totalChars = tmp.textContent.length;
        let shown = 0;
        const speed=6;
        const interval = setInterval(()=>{
          shown += 3;
          renderPartial(shown);
          if(shown >= totalChars){ clearInterval(interval); }
        }, speed);

        function renderPartial(charCount){
          let remaining = charCount;
          let out = '';
          for(const l of codeLines){
            const cls = l.t==='raw'?'':` class="${ {k:'k',fn:'t',s:'s',prompt:'c',attr:'t',tag:'k'}[l.t] || '' }"`;
            const plainText = l.text.replace(/&lt;/g,'<').replace(/&gt;/g,'>');
            if(remaining<=0){ break; }
            if(plainText.length <= remaining){
              out += `<span${cls}>${l.text}</span>`;
              remaining -= plainText.length;
            } else {
              const slice = plainText.slice(0, remaining).replace(/</g,'&lt;').replace(/>/g,'&gt;');
              out += `<span${cls}>${slice}</span>`;
              remaining = 0;
            }
          }
          el.innerHTML = out;
        }

        gsap.timeline({delay:0.3})
          .to('#pv1', {opacity:1, y:0, scale:1, duration:0.5, ease:'power2.out'}, 0.2)
          .to('#pv2', {opacity:1, y:0, scale:1, duration:0.5, ease:'power2.out'}, 0.9)
          .to('#pv3', {opacity:1, y:0, scale:1, duration:0.5, ease:'power2.out'}, 1.6)
          .to('#pv4', {opacity:1, y:0, scale:1, duration:0.5, ease:'power2.out'}, 2.1)
          .to('#pvbadge', {opacity:1, duration:0.4}, 2.4);
      }
    });
  }

  const integrationNames = [
    'Stripe','Supabase','Firebase','Auth0','PostgreSQL','Google Business',
    'App Store','Google Play','GitHub','OpenAI','Resend','Cloudflare'
  ];
  const orbitField = document.getElementById('orbitField');
  if(orbitField){
    const radii = [130,130,130,130,200,200,200,200,200,200,130,130];
    integrationNames.forEach((name,i)=>{
      const badge = document.createElement('div');
      badge.className='badge';
      badge.innerHTML = `<span>◇</span> ${name}`;
      orbitField.appendChild(badge);
      const angle = (i/integrationNames.length)*Math.PI*2;
      const radius = radii[i];
      badge.dataset.angle = angle;
      badge.dataset.radius = radius;
      badge.dataset.speed = (0.15 + Math.random()*0.1) * (i%2===0?1:-1);
    });

    let orbitBadges = orbitField.querySelectorAll('.badge');
    function animateOrbit(){
      const t = performance.now()/1000;
      orbitBadges.forEach(b=>{
        const baseAngle = parseFloat(b.dataset.angle);
        const speed = parseFloat(b.dataset.speed);
        const radius = parseFloat(b.dataset.radius);
        const angle = baseAngle + t*speed*0.3;
        const x = Math.cos(angle)*radius;
        const y = Math.sin(angle)*radius*0.55;
        b.style.transform = `translate(-50%,-50%) translate(${x}px, ${y}px)`;
      });
      requestAnimationFrame(animateOrbit);
    }
    animateOrbit();
  }
})();
