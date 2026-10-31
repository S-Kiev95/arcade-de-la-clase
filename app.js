// Arcade 3D: recorrido en primera persona; cada máquina abre un juego de pygame-ce compilado con pygbag.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const B = (x, y, z = 0) => new THREE.Vector3(x, z, -y);          // coordenadas de Blender -> three
const EYE = 1.6, RADIO = 0.28, VEL = 2.3, GIRO = 1.8;
const INTERIOR = new THREE.Box3(B(0.3, 8.9, -0.1), B(12.7, 0.3, 3.4));       // zona transitable del local
const SOLIDOS = /^(Pinball_\d|Mostrador_[AB]|Mesa_Alta_\d|Mesa_Baja|Sofa_(Pared|Frente)|Isla_Divisor|Nevera_Carcasa|Botellero_Mueble|Planta_\d|Taburete_\d_\d)$/;
const $ = (id) => document.getElementById(id);
const nombreMaquina = (m) => (m.num === 'pinball' ? 'PINBALL' : `MAQUINA ${m.num}`);
// La fuente arcade (Press Start 2P) dibuja Á, Ó, Í... como minúsculas: mayúsculas sin tildes, pero conservando la Ñ.
const retro = (s) => s.toUpperCase().normalize('NFD').replace(/(?!\u0303)[\u0300-\u036f]/g, '').normalize('NFC');

// ---------- motor
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.AgXToneMapping;                 // la misma curva que los renders de Blender
renderer.toneMappingExposure = 1.2;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07060c);
scene.fog = new THREE.FogExp2(0x0c0914, 0.016);              // aire del local: separa primer plano y fondo
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
// con postproceso el antialias del canvas no actúa: el render va a un destino con MSAA (WebGL2) y en coma flotante
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.4, 0.88));   // solo neón y pantallas, no el suelo
composer.addPass(new OutputPass());
let ancho = 0, alto = 0;
function ajustarTamano() {          // el canvas ocupa la ventana por CSS; aquí solo se iguala la resolución (giro del móvil, barras, etc.)
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  if (w === ancho && h === alto) return;
  ancho = w; alto = h;
  renderer.setSize(w, h, false); composer.setSize(w, h);
  camera.aspect = w / h; camera.fov = w < h ? 85 : 70; camera.updateProjectionMatrix();     // en vertical, más campo
}

// ---------- luz: sin luces dinámicas. La de Cycles (lámparas, neones, rebotes, sombras suaves) viene horneada en
// lightmaps por grupos de objetos (scripts/hornear.py); lo pequeño (botones, botellas, plantas) se ilumina con el
// panorama del propio local. Así el coste por píxel no crece con el número de lámparas.
const LUZ_HORNEADA = 1.0;                                     // ajuste global de los lightmaps
const LM = await fetch('modelo/lightmaps.json').then((r) => r.json()).catch(() => ({}));
const lmListo = Promise.all(Object.values(LM).map(async (d) => {
  const t = await new THREE.TextureLoader().loadAsync('modelo/' + d.archivo);
  t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.channel = 1;        // UV de glTF y segunda capa (TEXCOORD_1)
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  d.tex = t;
}));
const clonLM = new Map();
function conLightmap(m, g) {          // una copia del material por grupo: cada grupo tiene su propio atlas
  const k = m.uuid + g;
  if (!clonLM.has(k)) {
    const c = m.clone();
    c.lightMap = LM[g].tex;
    c.lightMapIntensity = Math.PI * LM[g].escala * LUZ_HORNEADA;      // three divide la luz difusa entre π
    c.envMapIntensity = 0.3;                                          // el entorno solo pone brillos: la difusa ya está horneada
    clonLM.set(k, c);
  }
  return clonLM.get(k);
}

// ---------- estado (empieza junto a la puerta mirando en diagonal hacia la isla y la pared de máquinas)
const yo = { pos: B(8.3, 1.3, EYE), yaw: Math.atan2(4.8, 6.5), pitch: -0.08, destino: null, ruta: null, prisa: false, alLlegar: null, vuelo: null };
const teclas = new Set();
let bloqueado = false;                       // mientras la cámara vuela hacia una máquina o se juega
let hoverSuelo = null;
const maquinas = new Map();                  // número -> { num, caja, centro, frente, juego, marq, base }
const solidos = [new THREE.Box3(B(10.6, 9.2, 0), B(13, 6.8, 3.4))];   // almacén y aseo (cerrados) + muebles
let bloqueos = solidos;                      // sólidos + máquinas: lo que frena al caminar

// ---------- juegos asignados (juegos.json lo edita el profe; ver README.md)
const cfg = await fetch('juegos.json').then((r) => r.json())
  .catch((e) => { console.error('juegos.json no es válido:', e); return { juegos: [] }; });
if (cfg.titulo) { $('titulo').textContent = retro(cfg.titulo); document.title = cfg.titulo; }
const juegoDe = new Map(cfg.juegos.map((j) => [j.maquina, j]));
await document.fonts.load('32px "Press Start 2P"').catch(() => {});

// ---------- entorno: panorama del propio local renderizado en Blender (reflejos y luz ambiente)
new THREE.TextureLoader().load('modelo/entorno.jpg', (t) => {
  t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
  scene.environment = new THREE.PMREMGenerator(renderer).fromEquirectangular(t).texture;
});

// ---------- carga del local
const VIDRIO = new THREE.MeshPhysicalMaterial({ color: 0x10141c, roughness: 0.04, metalness: 0, transparent: true,
  opacity: 0.16, depthWrite: false, envMapIntensity: 1.4 });
const BOTELLA_CLARA = new THREE.MeshPhysicalMaterial({ color: 0xd8eef0, roughness: 0.05, transparent: true, opacity: 0.4,
  clearcoat: 1, emissive: 0x9ab0b8, emissiveIntensity: 0.1, envMapIntensity: 1.2 });
// sin el bloom de Blender medido a mano: en la web estos emisores se quemaban (panel del botellero, LED de baldas)
const BRILLO_WEB = { panel_barra: 0.5, led_balda: 1.4, difusor_calido: 2.6 };
const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
new GLTFLoader().setDRACOLoader(draco).load('modelo/arcade.glb', async (gltf) => {
  await lmListo;
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const aniso = renderer.capabilities.getMaxAnisotropy();
  root.traverse((o) => {
    if (o.isMesh) {
      const m = o.material;
      if (m.name === 'vidrio') o.material = VIDRIO;                 // la transmisión real costaría otro render por fotograma
      else if (m.name === 'botella_claro') o.material = BOTELLA_CLARA;
      else {
        if (m.name.startsWith('neon_')) m.emissiveIntensity = 1.8;  // neones suaves: el bloom hace el resto
        else if (m.name in BRILLO_WEB) m.emissiveIntensity = BRILLO_WEB[m.name];
        else if (m.name.startsWith('botella_')) m.emissiveIntensity = 0.12;
        else if (m.emissiveIntensity > 4) m.emissiveIntensity = 3;
        m.envMapIntensity = 1.0;
        for (const k of ['map', 'normalMap', 'roughnessMap', 'emissiveMap']) if (m[k]) m[k].anisotropy = aniso;   // suelo nítido en ángulo
      }
      const g = o.userData.lightmap ?? o.parent?.userData?.lightmap;
      if (g && LM[g]?.tex) o.material = conLightmap(o.material, g);
    }
    const n = /^Maquina_(\d+)$/.exec(o.name);
    if (n) prepararMaquina(+n[1], o);
    else if (/^Pinball_\d$/.test(o.name) && juegoDe.has('pinball')) prepararPinball(o);
    else if (SOLIDOS.test(o.name)) solidos.push(new THREE.Box3().setFromObject(o));
  });
  colocarJugador();
  bloqueos = [...solidos, ...[...maquinas.values()].map((m) => m.caja)];
  prepararRejilla();
  scene.add(fusionar(root));
  construirLista();
  $('carga').hidden = true;
}, (e) => { $('barra').firstElementChild.style.width = Math.min(100, 100 * e.loaded / (e.total || 6e6)).toFixed(0) + '%'; },
(err) => { $('carga').querySelector('span').textContent = 'NO SE PUDO CARGAR EL MODELO'; console.error(err); });

// ---------- personajes (empleado.glb, jugador.glb): malla con esqueleto y sus animaciones. El local no tiene luces
// dinámicas: a cada uno lo ilumina un panorama HDR que Cycles renderiza donde está (scripts/render_entorno.py).
const PERSONAJES = [];
const pmrem = new THREE.PMREMGenerator(renderer);
const globo = { de: null, hasta: 0 };
const azar = (lista) => lista[Math.floor(Math.random() * lista.length)];
function personaje(def) {
  const p = { ...def, pos: null, giro: 0, caja: null, raiz: null, mixer: null, acciones: {}, actual: null, hasta: 0,
              cabeza: null, cara: null, mirar: 0, consejo: 0, formas: [], ojos: [], sonrisa: 0, cejas: 0,
              parpadeo: -9, proximoParpadeo: 1 + Math.random() * 3, sacada: new THREE.Vector3(), proximaSacada: 0 };
  PERSONAJES.push(p);
  Promise.all([new GLTFLoader().setDRACOLoader(draco).loadAsync(def.glb), new RGBELoader().loadAsync(def.luz)]).then(([gltf, hdr]) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const luz = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose();
    p.raiz = gltf.scene;
    p.raiz.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;                                   // la caja de la pose de reposo no cubre los brazos en alto
      o.material.envMap = luz; o.material.envMapIntensity = 1;
      // MakeHuman: cejas y pestañas con borde suave (son finas y van delante de la piel); el pelo, recortado más bajo
      if (/eyebrow|eyelashes/.test(o.material.name)) Object.assign(o.material, { alphaTest: 0.02, transparent: true, depthWrite: false });
      else if (o.material.alphaTest) o.material.alphaTest = 0.35;
      if (o.morphTargetDictionary) p.formas.push(o);             // gestos de la cara: parpadeo, sonrisa, cejas, boca
    });
    p.ojos = ['ojo_l', 'ojo_r'].map((n) => p.raiz.getObjectByName(n)).filter(Boolean);
    p.ojosReposo = p.ojos.map((o) => o.quaternion.clone());
    p.raiz.add(sombraDifusa(...p.sombra));
    p.mixer = new THREE.AnimationMixer(p.raiz);
    for (const c of gltf.animations) p.acciones[c.name] = p.mixer.clipAction(c);
    p.raiz.updateMatrixWorld(true);                              // pose de reposo: hacia dónde mira la cara, en ejes de la cabeza
    p.cabeza = p.raiz.getObjectByName('head');                 // esqueleto game_engine de MakeHuman
    p.cabezaReposo = p.cabeza.quaternion.clone();
    p.cara = new THREE.Vector3(0, 0, 1).applyQuaternion(p.cabeza.getWorldQuaternion(new THREE.Quaternion()).invert());
    montar(p);
  }).catch((e) => console.error('No se pudo cargar', def.glb, e));
  return p;
}
function colocar(p, pos, giro) {             // sitio, giro y caja de choque (también se le puede hacer clic)
  p.pos = pos; p.giro = giro;
  p.caja = new THREE.Box3(pos.clone().add(new THREE.Vector3(-0.25, 0, -0.25)), pos.clone().add(new THREE.Vector3(0.25, 1.9, 0.25)));
  p.caja.pnj = p;
  solidos.push(p.caja);
  montar(p);
}
function montar(p) {                         // entra en escena cuando ya tiene modelo y sitio (llegan en cualquier orden)
  if (!p.raiz || !p.pos || p.raiz.parent) return;
  p.raiz.position.copy(p.pos); p.raiz.rotation.y = p.giro;
  scene.add(p.raiz);
  p.iniciar(p);
}
function sombraDifusa(ancho, fondo) {         // mancha oscura bajo los pies: los personajes no salen en los lightmaps
  const [c, x] = lienzo(128, 128);
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(0, 0, 0, 0.55)'); g.addColorStop(0.6, 'rgba(0, 0, 0, 0.3)'); g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(ancho, fondo),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.006;
  return m;
}
function poner(p, nombre, fundido = 0.5) {
  const a = p.acciones[nombre];
  if (!a || a === p.actual) return;
  a.reset().fadeIn(fundido).play();
  p.actual?.fadeOut(fundido);
  p.actual = a;
}
function decir(p, texto, segundos) {
  const g = $('globo');
  g.innerHTML = `<b>${p.titulo}</b>`;
  g.append(texto);
  Object.assign(globo, { de: p, hasta: reloj.elapsedTime + segundos });
}

const EMPLEADO = personaje({
  glb: 'modelo/empleado.glb', luz: 'modelo/entorno_barra.hdr', titulo: 'EMPLEADO', mira: true, sombra: [0.7, 0.55], sonrisaReposo: 0.12,
  saludos: ['¡Hola! Bienvenido al arcade de la clase.', '¡Buenas! Elige una máquina y a jugar.', '¡Hola! Hoy las máquinas están que arden.'],
  iniciar(p) {
    const sal = p.acciones.Saludar;
    sal.setLoop(THREE.LoopOnce, 1); sal.clampWhenFinished = true;
    p.mixer.addEventListener('finished', (e) => { if (e.action === sal) p.rutina(p, true); });
    p.rutina(p, true);
  },
  rutina(p, ya) {                            // alterna limpiar la barra (10-14 s) y un respiro de pie (5 s)
    if (!ya && reloj.elapsedTime < p.hasta) return;
    const sig = p.actual === p.acciones.Limpiar ? 'Reposo' : 'Limpiar';
    p.hasta = reloj.elapsedTime + (sig === 'Limpiar' ? 10 + Math.random() * 4 : 5);
    poner(p, sig);
  },
  actualizar(p, dt, d) {
    if (d > 5) p.saludado = false;                               // al volver a acercarse, saluda otra vez
    if (d < 3.2 && !p.saludado) { p.saludado = true; poner(p, 'Saludar', 0.3); decir(p, azar(p.saludos), 3.5); }
    if (p.actual !== p.acciones.Saludar) p.rutina(p, false);
  },
  hablar(p) {                                // clic en el empleado: un consejo distinto cada vez
    const c = ['Haz clic en una máquina para jugar. Con Esc vuelves al local.'];
    for (const m of [...maquinas.values()].filter((x) => x.juego)) c.push(m.num === 'pinball'
      ? `¿Una de pinball? Prueba «${m.juego.titulo}», de ${m.juego.autor || 'la clase'}.`
      : `En la máquina ${m.num} está «${m.juego.titulo}», de ${m.juego.autor || 'la clase'}. ¡Pruébala!`);
    c.push('Camina con W A S D o haciendo clic en el suelo.', 'Las máquinas sin juego esperan los vuestros. ¡Pronto habrá más!');
    decir(p, c[p.consejo++ % c.length], 5);
    if (!p.saludado) { p.saludado = true; poner(p, 'Saludar', 0.3); }
  },
});
colocar(EMPLEADO, B(10.6, 3.9, 0), -Math.PI / 2);

const JUGADOR = personaje({                  // un cliente jugando en una máquina libre (colocarJugador, al cargar el local)
  glb: 'modelo/jugador.glb', luz: 'modelo/entorno_jugador.hdr', titulo: 'JUGADOR', sombra: [0.7, 0.55], sonrisaReposo: 0,
  iniciar(p) {
    const cel = p.acciones.Celebrar;
    cel.setLoop(THREE.LoopOnce, 1); cel.clampWhenFinished = true;
    p.mixer.addEventListener('finished', (e) => { if (e.action === cel) { poner(p, 'Jugar', 0.4); p.hasta = reloj.elapsedTime + 25 + Math.random() * 20; } });
    poner(p, 'Jugar', 0);
    p.hasta = reloj.elapsedTime + 15 + Math.random() * 15;
  },
  actualizar(p, dt, d) {                     // de vez en cuando bate un récord y lo celebra
    if (p.actual !== p.acciones.Jugar || reloj.elapsedTime < p.hasta) return;
    poner(p, 'Celebrar', 0.3);
    if (d < 6) decir(p, azar(['¡Toma ya! ¡Nuevo récord!', '¡Sííí! ¡Nivel superado!', '¡Lo conseguí, lo conseguí!']), 3);
  },
  hablar(p) {
    const j = azar([...maquinas.values()].filter((m) => m.juego));
    const c = ['¡Shh! Que voy por el récord.', 'Cuando acabe la partida te la dejo, prometido.',
               'Esta máquina aún no tiene juego de la clase… así que me lo invento.'];
    if (j) c.splice(1, 0, j.num === 'pinball' ? `¿Has probado el pinball? «${j.juego.titulo}» engancha.`
      : `Prueba «${j.juego.titulo}» en la máquina ${j.num}. ¡Está muy chulo!`);
    decir(p, c[p.consejo++ % c.length], 4);
  },
});
function colocarJugador() {                  // delante de una máquina sin juego: si el profe le asigna uno, se cambia de máquina
  const m = [10, 3, 15, 11, 20, 5].map((n) => maquinas.get(n)).find((x) => x && !x.juego)
    || [...maquinas.values()].find((x) => x.num !== 'pinball' && !x.juego);
  if (!m) return;                            // todas tienen juego: hoy no viene
  const frente = new THREE.Vector3(0, 0, 1).applyQuaternion(m.nodo.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize();
  colocar(JUGADOR, m.nodo.getWorldPosition(new THREE.Vector3()).addScaledVector(frente, 0.45).setY(0), Math.atan2(-frente.x, -frente.z));
  m.ocupada = JUGADOR;
}

const IDENTIDAD = new THREE.Quaternion(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
const qc = new THREE.Quaternion(), qd = new THREE.Quaternion();
const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), vd = new THREE.Vector3();
function gesto(p, nombre, valor) {
  for (const m of p.formas) { const i = m.morphTargetDictionary[nombre]; if (i !== undefined) m.morphTargetInfluences[i] = valor; }
}
function girarHacia(hueso, adelante, objetivo, max, peso) {   // rota un hueso (sobre la animación) para que mire al objetivo
  const mundo = hueso.getWorldQuaternion(qa);
  const total = qb.setFromUnitVectors(vc.copy(adelante).applyQuaternion(mundo),
    vd.copy(objetivo).sub(hueso.getWorldPosition(va)).normalize());
  const ang = 2 * Math.acos(Math.min(1, Math.abs(total.w)));
  const giro = qc.copy(IDENTIDAD).slerp(total, Math.min(1, max / Math.max(ang, 1e-6)) * peso);
  hueso.quaternion.copy(hueso.parent.getWorldQuaternion(qd).invert().multiply(giro.multiply(mundo)));   // de mundo a local
}
const ADELANTE_OJO = new THREE.Vector3(0, 1, 0);           // el hueso de cada ojo apunta a donde mira (su eje Y)
function cara(p, dt, habla) {                              // parpadeo, sonrisa, cejas y boca
  const t = reloj.elapsedTime;
  if (t > p.proximoParpadeo) {                               // cada 2-6 s, a veces doble
    p.parpadeo = t;
    p.proximoParpadeo = t + (Math.random() < 0.15 ? 0.35 : 2 + Math.random() * 4);
  }
  const f = (t - p.parpadeo) / 0.17;                         // cierra en 60 ms y abre en 110 ms
  const cierre = f < 0 || f > 1 ? 0 : f < 0.35 ? f / 0.35 : 1 - (f - 0.35) / 0.65;
  gesto(p, 'parpadeo_l', cierre);
  gesto(p, 'parpadeo_r', cierre);
  const amable = habla || p.actual === p.acciones.Saludar || p.actual === p.acciones.Celebrar;
  p.sonrisa += ((amable ? 0.75 : p.sonrisaReposo ?? 0.08) - p.sonrisa) * Math.min(1, dt * 4);
  p.cejas += ((p.actual === p.acciones.Saludar || p.actual === p.acciones.Celebrar ? 0.6 : 0) - p.cejas) * Math.min(1, dt * 5);
  gesto(p, 'sonrisa', p.sonrisa);
  gesto(p, 'cejas_arriba', p.cejas);
  gesto(p, 'boca', habla ? 0.12 + 0.18 * Math.abs(Math.sin(t * 13) * Math.sin(t * 5.3)) : 0);   // mueve la boca al hablar
}
function mirada(p, objetivo) {                             // los ojos van al objetivo con pequeños saltos (sacadas)
  const t = reloj.elapsedTime;
  if (t > p.proximaSacada) {
    p.sacada.set((Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.06);
    p.proximaSacada = t + 0.4 + Math.random() * 1.6;
  }
  const o = objetivo.clone().add(p.sacada);
  for (const e of p.ojos) girarHacia(e, ADELANTE_OJO, o, 0.45, 1);           // máx. ~26° respecto a la cabeza
}
function actualizarPersonajes(dt) {
  for (const p of PERSONAJES) {
    if (!p.raiz?.parent) continue;
    const d = Math.hypot(yo.pos.x - p.pos.x, yo.pos.z - p.pos.z);
    p.cabeza.quaternion.copy(p.cabezaReposo);                    // los giros hacia el jugador no se acumulan
    p.ojos.forEach((o, i) => o.quaternion.copy(p.ojosReposo[i]));
    p.actualizar(p, dt, d);
    p.mixer.update(dt);
    p.raiz.updateMatrixWorld(true);
    const habla = globo.de === p && reloj.elapsedTime < globo.hasta;
    cara(p, dt, habla);
    // cabeza hacia el jugador (encima de la animación) si está cerca y delante de él: máx. ~55°
    const haciaYo = vb.copy(camera.position).sub(p.cabeza.getWorldPosition(va)).normalize();
    const delante = vc.set(0, 0, 1).applyQuaternion(p.raiz.quaternion).dot(haciaYo) > -0.2;
    p.mirar += (((p.mira || habla) && d < 4.5 && delante ? 1 : 0) - p.mirar) * Math.min(1, dt * 3);
    if (p.mirar > 0.01) girarHacia(p.cabeza, p.cara, camera.position, 0.95, p.mirar);
    p.raiz.updateMatrixWorld(true);
    // ojos: al jugador si lo atiende; si no, al frente (la barra, la pantalla de su máquina...)
    if (p.mirar > 0.5) mirada(p, camera.position);
    else mirada(p, p.cabeza.localToWorld(vb.copy(p.cara).multiplyScalar(0.8).setY(0.08)));
  }
  const g = $('globo'), p = globo.de;                            // globo de diálogo sobre la cabeza de quien habla
  if (!p || reloj.elapsedTime > globo.hasta) { g.hidden = true; return; }
  const s = p.cabeza.getWorldPosition(va);
  const q = vc.copy(s).setY(s.y + 0.34).project(camera);
  g.hidden = q.z > 1 || Math.abs(q.x) > 1.05 || Math.abs(q.y) > 1.05 || camera.position.distanceTo(s) > 10;
  if (!g.hidden) { g.style.left = (q.x + 1) / 2 * ancho + 'px'; g.style.top = (1 - q.y) / 2 * alto + 'px'; }
}

// El pinball se juega como una máquina más (clave "pinball" en juegos.json): se camina hasta el lado de los flippers.
function prepararPinball(nodo) {
  const pre = nodo.name.replace('_', '');                   // Pinball_1 -> piezas Pinball1_Tablero, Pinball1_Backglass...
  const caja = new THREE.Box3().setFromObject(nodo);
  const centro = new THREE.Box3().setFromObject(nodo.getObjectByName(pre + '_Tablero')).getCenter(new THREE.Vector3());
  const frente = new THREE.Box3().setFromObject(nodo.getObjectByName(pre + '_Barra')).getCenter(new THREE.Vector3())
    .sub(caja.getCenter(new THREE.Vector3())).setY(0).normalize();
  const juego = juegoDe.get('pinball');
  const respaldo = nodo.getObjectByName(pre + '_Backglass');
  respaldo.material = new THREE.MeshBasicMaterial({ map: texturaRespaldo(juego.titulo), toneMapped: false });
  maquinas.set('pinball', { num: 'pinball', caja, centro, frente, juego, marq: respaldo.material, base: 1 });
}

function prepararMaquina(num, nodo) {
  const pantalla = nodo.getObjectByName(nodo.name + '_Pantalla');
  const marq = nodo.getObjectByName(nodo.name + '_Marquesina');
  const caja = new THREE.Box3().setFromObject(nodo);
  const centro = new THREE.Box3().setFromObject(pantalla).getCenter(new THREE.Vector3());
  const frente = centro.clone().sub(caja.getCenter(new THREE.Vector3())).setY(0).normalize();
  const juego = juegoDe.get(num);
  if (juego) {
    pantalla.material = new THREE.MeshBasicMaterial({ map: texturaPantalla(juego), toneMapped: false });
    marq.material = new THREE.MeshBasicMaterial({ map: texturaMarquesina(juego.titulo, num), toneMapped: false });
  } else marq.material = marq.material.clone();               // propio, para iluminarlo al pasar el puntero
  maquinas.set(num, { num, nodo, caja, centro, frente, juego, marq: marq.material, base: marq.material.emissiveIntensity ?? 1 });
}

// Une las mallas que comparten material: ~950 llamadas de dibujo pasan a ~130 (clave en portátiles y móviles).
function fusionar(root) {
  const grupos = new Map();
  root.traverse((o) => { if (o.isMesh) (grupos.get(o.material) || grupos.set(o.material, []).get(o.material)).push(o); });
  const todo = new THREE.Group();
  for (const [mat, mallas] of grupos) {
    const usar = ['position', 'normal', 'uv', ...(mat.vertexColors ? ['color'] : []), ...(mat.lightMap ? ['uv1'] : [])];
    const geos = mallas.map((m) => {
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (!usar.includes(k)) g.deleteAttribute(k);
      m.geometry.dispose();
      return g;
    });
    const malla = new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos) : geos[0], mat);
    malla.name = mat.name;
    todo.add(malla);
  }
  return todo;
}

// ---------- texturas dinámicas: título del alumno en pantalla y marquesina
const NEON = ['#ff2a8a', '#29c8ff', '#ffb020', '#a64dff', '#3cff8a'];
function lienzo(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function aTextura(c) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; return t; }
function encajar(ctx, txt, max, size) { ctx.font = `${size}px "Press Start 2P"`; while (ctx.measureText(txt).width > max && size > 10) { size -= 2; ctx.font = `${size}px "Press Start 2P"`; } }
function texturaPantalla(j) {
  const [c, x] = lienzo(640, 480);
  const tex = aTextura(c), col = NEON[j.maquina % NEON.length], titulo = retro(j.titulo);
  const pintar = (im) => {
    x.fillStyle = '#05040c'; x.fillRect(0, 0, 640, 480);
    x.textAlign = 'center';
    if (im) {                                                   // portada (captura del juego) a sangre
      const k = Math.max(640 / im.width, 480 / im.height);
      x.drawImage(im, 320 - im.width * k / 2, 240 - im.height * k / 2, im.width * k, im.height * k);
      x.fillStyle = 'rgba(5, 4, 12, 0.82)'; x.fillRect(0, 392, 640, 88);
    } else {
      x.shadowColor = col; x.shadowBlur = 18; x.fillStyle = col;
      encajar(x, titulo, 580, 40); x.fillText(titulo, 320, 150);
      x.shadowBlur = 0; x.fillStyle = '#d8d4ea'; x.font = '16px "Press Start 2P"';
      x.fillText(retro('por ' + (j.autor || 'anónimo')).slice(0, 34), 320, 212);
    }
    x.fillStyle = '#ffffff'; x.font = '22px "Press Start 2P"';
    x.fillText('HAZ CLIC PARA JUGAR', 320, im ? 448 : 340);
    x.fillStyle = 'rgba(0, 0, 0, 0.28)';
    for (let y = 0; y < 480; y += 3) x.fillRect(0, y, 640, 1);  // líneas de barrido CRT
    tex.needsUpdate = true;
  };
  pintar(null);
  if (j.portada) { const im = new Image(); im.onload = () => pintar(im); im.src = j.portada; }
  return tex;
}
function texturaRespaldo(titulo) {           // respaldo (backglass) del pinball con el título del juego
  const [c, x] = lienzo(768, 768);
  const g = x.createLinearGradient(0, 0, 0, 768); g.addColorStop(0, '#320c50'); g.addColorStop(1, '#060410');
  x.fillStyle = g; x.fillRect(0, 0, 768, 768);
  x.strokeStyle = 'rgba(160, 60, 255, 0.5)'; x.lineWidth = 3;
  for (let k = 0; k < 12; k++) { const y = 476 + (k / 11) ** 1.6 * 292; x.beginPath(); x.moveTo(0, y); x.lineTo(768, y); x.stroke(); }
  for (let k = -9; k <= 9; k++) { x.beginPath(); x.moveTo(384 + k * 20, 476); x.lineTo(384 + k * 110, 768); x.stroke(); }
  x.fillStyle = 'rgba(255, 60, 150, 0.3)'; x.beginPath(); x.arc(384, 270, 170, 0, Math.PI * 2); x.fill();
  const p = retro(titulo).split(' '), mitad = Math.ceil(p.length / 2);
  const lineas = p.length > 1 ? [p.slice(0, mitad).join(' '), p.slice(mitad).join(' ')] : p;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  lineas.forEach((l, i) => {
    const col = i ? '#29c8ff' : '#ff2a8a';
    x.fillStyle = col; x.shadowColor = col; x.shadowBlur = 30;
    encajar(x, l, 700, 110); x.fillText(l, 384, lineas.length > 1 ? 190 + i * 150 : 265);
  });
  x.shadowBlur = 0; x.strokeStyle = '#ffbe28'; x.lineWidth = 10; x.strokeRect(8, 8, 752, 752);
  return aTextura(c);
}
function texturaMarquesina(titulo, num) {
  const [c, x] = lienzo(1024, 392);
  const g = x.createLinearGradient(0, 0, 0, 392); g.addColorStop(0, '#1a0f3a'); g.addColorStop(1, '#05040a');
  x.fillStyle = g; x.fillRect(0, 0, 1024, 392);
  const col = NEON[num % NEON.length];
  x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = col; x.shadowColor = col; x.shadowBlur = 30;
  encajar(x, retro(titulo), 940, 84); x.fillText(retro(titulo), 512, 196);
  return aTextura(c);
}

// ---------- lista lateral de juegos
function construirLista() {
  const nav = $('lista');
  const asignadas = [...maquinas.values()].filter((m) => m.juego)
    .sort((a, b) => (a.num === 'pinball') - (b.num === 'pinball') || a.num - b.num);
  if (!asignadas.length) { const p = document.createElement('span'); p.textContent = 'Aún no hay juegos asignados.'; nav.append(p); }
  for (const m of asignadas) {
    const b = document.createElement('button');
    b.append(document.createElement('div'), document.createElement('span'));
    b.firstChild.textContent = m.juego.titulo;
    b.lastChild.textContent = `${m.num === 'pinball' ? 'Pinball' : 'Máquina ' + m.num} · ${m.juego.autor || ''}`;
    b.onclick = () => abrir(m);
    nav.append(b);
  }
}

// ---------- selección: cajas de las máquinas y los muebles + plano del suelo (sin recorrer triángulos)
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(), tmp = new THREE.Vector3();
const SUELO = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function apuntar(e) {             // { maquina } | { suelo: punto } | null
  ptr.set(e.clientX / ancho * 2 - 1, -(e.clientY / alto) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const r = ray.ray;
  let cerca = Infinity, maq = null;
  const probar = (caja, m) => { if (r.intersectBox(caja, tmp)) { const d = tmp.distanceTo(r.origin); if (d < cerca) { cerca = d; maq = m; } } };
  for (const m of maquinas.values()) probar(m.caja, m);
  for (const c of solidos) probar(c, c.pnj ?? null);
  if (r.intersectPlane(SUELO, tmp) && tmp.distanceTo(r.origin) < cerca && INTERIOR.containsPoint(tmp)) return { suelo: tmp.clone() };
  if (PERSONAJES.includes(maq)) return cerca < 9 ? { pnj: maq } : null;
  return maq && cerca < 9 ? { maquina: maq } : null;
}

const aro = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.19, 48),
  new THREE.MeshBasicMaterial({ color: 0x29c8ff, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false }));
aro.rotation.x = -Math.PI / 2;
scene.add(aro);
let resaltada = null;
function resaltar(m) {
  if (m === resaltada) return;
  for (const [x, k] of [[resaltada, 1], [m, 1.7]]) {
    if (x?.marq.isMeshBasicMaterial) x.marq.color.setScalar(k);
    else if (x) x.marq.emissiveIntensity = x.base * k;
  }
  resaltada = m;
}
function hover(e) {
  const a = bloqueado ? null : apuntar(e);
  const m = a?.maquina, pnj = a?.pnj;
  resaltar(m || null);
  hoverSuelo = a?.suelo || null;
  const tip = $('tip');
  tip.hidden = !m && !pnj;
  if (m || pnj) {
    tip.innerHTML = `<b>${pnj ? pnj.titulo : nombreMaquina(m)}</b>`;
    tip.append(pnj ? 'Haz clic para hablar con él' : m.juego ? `${m.juego.titulo} · ${m.juego.autor || ''}` : 'Próximamente');
    tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
    tip.style.transform = e.clientX > ancho - 280 ? 'translate(calc(-100% - 14px), 14px)' : '';
  }
  lienzoGL.style.cursor = m || pnj ? 'pointer' : hoverSuelo ? 'crosshair' : 'grab';
}

// ---------- entrada: teclado, arrastrar para mirar (como en el recorrido de la casa), clic para andar o jugar
addEventListener('keydown', (e) => {
  if (!$('juego').hidden) { if (e.key === 'Escape') cerrar(); return; }
  if (e.key === 'Escape' && bloqueado) { yo.ruta = yo.vuelo = yo.alLlegar = null; bloqueado = false; return; }   // cancela el viaje
  teclas.add(e.key.toLowerCase());
});
addEventListener('keyup', (e) => teclas.delete(e.key.toLowerCase()));
addEventListener('blur', () => teclas.clear());
const lienzoGL = renderer.domElement;
let arrastre = null;
lienzoGL.addEventListener('pointerdown', (e) => { arrastre = { x: e.clientX, y: e.clientY, d: 0 }; lienzoGL.setPointerCapture(e.pointerId); });
lienzoGL.addEventListener('pointermove', (e) => {
  if (!arrastre) { if (e.pointerType === 'mouse') hover(e); return; }
  const dx = e.clientX - arrastre.x, dy = e.clientY - arrastre.y;
  arrastre.d += Math.abs(dx) + Math.abs(dy); arrastre.x = e.clientX; arrastre.y = e.clientY;
  if (bloqueado || arrastre.d < 6) return;
  yo.yaw += dx * 0.0042; yo.pitch = Math.max(-1.2, Math.min(1.2, yo.pitch + dy * 0.0042));
  hoverSuelo = null; $('tip').hidden = true; resaltar(null);
});
lienzoGL.addEventListener('pointerup', (e) => {
  if (arrastre && arrastre.d < 6 && !bloqueado) {
    const a = apuntar(e);
    if (a?.maquina) abrir(a.maquina);
    else if (a?.pnj) a.pnj.hablar(a.pnj);
    else if (a?.suelo) { yo.ruta = ruta(yo.pos, a.suelo); yo.prisa = false; yo.destino = yo.ruta && a.suelo; }
  }
  arrastre = null;
});
lienzoGL.addEventListener('pointercancel', () => { arrastre = null; });
lienzoGL.addEventListener('pointerleave', () => { if (!arrastre) { hoverSuelo = null; $('tip').hidden = true; resaltar(null); } });

// ---------- abrir / cerrar una máquina: camina hasta ella esquivando muebles, se encara a la pantalla y abre el juego
function abrir(m) {
  if (bloqueado) return;
  if (m.ocupada) { decir(m.ocupada, '¡Está ocupada! Prueba otra máquina.', 3); return; }
  $('tip').hidden = true; resaltar(null); hoverSuelo = null;
  const pos = m.centro.clone().addScaledVector(m.frente, 0.95).setY(EYE - 0.05);
  const encarar = () => {
    const mira = m.centro.clone().sub(pos);
    yo.vuelo = { de: yo.pos.clone(), a: pos, yaw0: yo.yaw, yaw1: Math.atan2(-mira.x, -mira.z), p0: yo.pitch,
                 p1: Math.atan2(mira.y, Math.hypot(mira.x, mira.z)), t: 0, fin: () => mostrarJuego(m) };
  };
  const camino = yo.pos.distanceTo(pos) > 0.4 && ruta(yo.pos, pos);
  bloqueado = true; yo.destino = null;
  if (camino) Object.assign(yo, { ruta: camino, prisa: true, alLlegar: encarar });
  else encarar();
}
function mostrarJuego(m) {
  $('jTitulo').textContent = m.juego ? retro(m.juego.titulo) : nombreMaquina(m);
  $('jAutor').textContent = m.juego ? `por ${m.juego.autor || 'anónimo'}` : 'Esta máquina aún no tiene juego.';
  $('ayuda').textContent = m.juego ? `${m.juego.controles || ''} Haz clic en la pantalla si no responde al teclado.`.trim() : '';
  $('jFull').hidden = !m.juego;
  $('pronto').hidden = !!m.juego;
  const pant = $('pantalla');
  const [aw, ah] = (m.juego?.aspecto || '4/3').split('/').map(Number);     // p. ej. el pinball es vertical (3/4)
  pant.style.aspectRatio = `${aw} / ${ah}`;
  pant.style.width = `min(100%, calc(72vh * ${aw / ah}))`;
  pant.querySelector('iframe')?.remove();
  if (m.juego) {
    const f = document.createElement('iframe');
    f.src = m.juego.url; f.allow = 'autoplay; fullscreen; gamepad'; f.title = m.juego.titulo;
    f.addEventListener('load', () => {
      try {                                                     // mismo dominio: fondo negro (pygbag lo pone gris) y Esc para salir
        const d = f.contentDocument;
        d.head.append(Object.assign(d.createElement('style'), { textContent: 'html, body { background: #000 !important; }' }));
        f.contentWindow.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrar(); });
      } catch { /* juego alojado en otro dominio */ }
      f.focus();
    });
    pant.append(f);
  }
  $('juego').hidden = false;
  $('globo').hidden = true; globo.hasta = 0;
  $('jSalir').focus();
}
function cerrar() {
  $('pantalla').querySelector('iframe')?.remove();             // detiene el juego y libera memoria
  $('juego').hidden = true; bloqueado = false; teclas.clear();
  yo.ruta = yo.vuelo = yo.alLlegar = null;                      // ningún viaje pendiente puede reabrir el juego
  document.activeElement?.blur();                                // que Espacio/Intro no vuelvan a pulsar un botón
  mover(Math.sin(yo.yaw) * 0.4, Math.cos(yo.yaw) * 0.4);       // un paso atrás
  arrancar();
}
$('jSalir').onclick = cerrar;
$('jFull').onclick = () => $('pantalla').querySelector('iframe')?.requestFullscreen?.().catch(() => {});

// ---------- colisiones en planta
function libre(x, z) {
  if (x < INTERIOR.min.x || x > INTERIOR.max.x || z < INTERIOR.min.z || z > INTERIOR.max.z) return false;
  return !bloqueos.some((c) => x > c.min.x - RADIO && x < c.max.x + RADIO && z > c.min.z - RADIO && z < c.max.z + RADIO);
}
function mover(dx, dz) {
  if (!libre(yo.pos.x, yo.pos.z)) { yo.pos.x += dx; yo.pos.z += dz; return; }   // si quedó encajado, lo deja salir
  if (libre(yo.pos.x + dx, yo.pos.z)) yo.pos.x += dx;
  if (libre(yo.pos.x, yo.pos.z + dz)) yo.pos.z += dz;
}

// ---------- rutas: rejilla de 15 cm sobre la planta, búsqueda en anchura desde el destino y atajos en línea recta
const PASO = 0.15, VECINOS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
let rejilla, NX, NZ;
const cx = (i) => INTERIOR.min.x + (i + 0.5) * PASO, cz = (j) => INTERIOR.min.z + (j + 0.5) * PASO;
function prepararRejilla() {
  NX = Math.ceil((INTERIOR.max.x - INTERIOR.min.x) / PASO); NZ = Math.ceil((INTERIOR.max.z - INTERIOR.min.z) / PASO);
  rejilla = new Uint8Array(NX * NZ);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) rejilla[i + j * NX] = libre(cx(i), cz(j));
}
function visible(a, b) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.08);
  for (let k = 1; k <= n; k++) if (!libre(a.x + (b.x - a.x) * k / n, a.z + (b.z - a.z) * k / n)) return false;
  return true;
}
function ruta(desde, hasta) {             // lista de puntos hasta el destino, o null si no se llega
  const celda = (p) => Math.floor((p.x - INTERIOR.min.x) / PASO) + Math.floor((p.z - INTERIOR.min.z) / PASO) * NX;
  let meta = new THREE.Vector3(hasta.x, EYE, hasta.z);
  if (!libre(meta.x, meta.z)) {          // destino pegado a un mueble: la celda libre más cercana
    let mejor = null, dm = 1.2;
    for (let c = 0; c < rejilla.length; c++) {
      if (!rejilla[c]) continue;
      const p = new THREE.Vector3(cx(c % NX), EYE, cz(Math.floor(c / NX))), d = p.distanceTo(meta);
      if (d < dm) { dm = d; mejor = p; }
    }
    if (!mejor) return null;
    meta = mejor;
  }
  if (visible(desde, meta)) return [meta];
  const inicio = celda(desde), fin = celda(meta), padre = new Int32Array(NX * NZ).fill(-1), cola = [fin];
  const pasa = (i, j) => i >= 0 && j >= 0 && i < NX && j < NZ && (rejilla[i + j * NX] || i + j * NX === inicio);
  padre[fin] = fin;
  for (let q = 0; q < cola.length && padre[inicio] < 0; q++) {
    const c = cola[q], i = c % NX, j = (c - i) / NX;
    for (const [di, dj] of VECINOS) {
      const n = c + di + dj * NX;
      const esquina = di && dj && !(pasa(i + di, j) && pasa(i, j + dj));       // sin cortar esquinas de muebles
      if (pasa(i + di, j + dj) && padre[n] < 0 && !esquina) { padre[n] = c; cola.push(n); }
    }
  }
  if (padre[inicio] < 0) return null;
  const puntos = [];
  for (let c = padre[inicio]; c !== fin; c = padre[c]) puntos.push(new THREE.Vector3(cx(c % NX), EYE, cz(Math.floor(c / NX))));
  puntos.push(meta);
  const final = [];
  let a = desde;
  for (let k = 0; k < puntos.length; k++) {
    if (k + 1 < puntos.length && visible(a, puntos[k + 1])) continue;
    final.push(puntos[k]); a = puntos[k];
  }
  return final;
}
function seguirRuta(dt) {
  const obj = yo.ruta[0], d = obj.clone().sub(yo.pos).setY(0), paso = VEL * (yo.prisa ? 1.5 : 1) * dt;
  if (yo.prisa && d.length() > 0.05) {   // camino a una máquina: mira hacia donde va
    const giro = Math.atan2(-d.x, -d.z) - yo.yaw;
    yo.yaw += Math.atan2(Math.sin(giro), Math.cos(giro)) * Math.min(1, dt * 6);
    yo.pitch += (-0.06 - yo.pitch) * Math.min(1, dt * 4);
  }
  if (d.length() > paso) { yo.pos.addScaledVector(d, paso / d.length()); return; }
  yo.pos.x = obj.x; yo.pos.z = obj.z; yo.ruta.shift();
  if (yo.ruta.length) return;
  const fin = yo.alLlegar;
  yo.ruta = yo.alLlegar = yo.destino = null;
  fin?.();
}

// ---------- bucle (se detiene mientras se juega: todo el procesador queda para el juego)
const reloj = new THREE.Clock();
const suave = (t) => t * t * (3 - 2 * t);
const tecla = (...ks) => ks.some((k) => teclas.has(k));
let enMarcha = false;
function arrancar() { if (!enMarcha) { enMarcha = true; reloj.getDelta(); requestAnimationFrame(frame); } }
function frame() {
  if (!$('juego').hidden) { enMarcha = false; return; }
  const dt = Math.min(reloj.getDelta(), 0.05);
  const f = tecla('w', 'arrowup') - tecla('s', 'arrowdown'), s = tecla('d') - tecla('a');
  const giro = tecla('arrowleft', 'q') - tecla('arrowright', 'e');
  if (!bloqueado && (f || s || giro)) yo.ruta = yo.destino = null;            // el teclado manda sobre el clic
  if (yo.vuelo) {
    const v = yo.vuelo; v.t = Math.min(1, v.t + dt / 0.6); const k = suave(v.t);
    yo.pos.lerpVectors(v.de, v.a, k);
    const dy = Math.atan2(Math.sin(v.yaw1 - v.yaw0), Math.cos(v.yaw1 - v.yaw0));
    yo.yaw = v.yaw0 + dy * k; yo.pitch = v.p0 + (v.p1 - v.p0) * k;
    if (v.t >= 1) { yo.vuelo = null; v.fin(); }
  } else if (yo.ruta) seguirRuta(dt);
  else if (!bloqueado) {
    yo.yaw += giro * GIRO * dt;
    if (f || s) {
      const v = VEL * (tecla('shift') ? 1.8 : 1) * dt / Math.hypot(f, s);
      const fx = -Math.sin(yo.yaw), fz = -Math.cos(yo.yaw);
      mover((fx * f - fz * s) * v, (fz * f + fx * s) * v);
    }
  }
  const p = yo.destino || hoverSuelo;
  aro.visible = !!p && !bloqueado;
  if (p) aro.position.set(p.x, 0.012, p.z);
  camera.position.copy(yo.pos);
  camera.rotation.set(yo.pitch, yo.yaw, 0, 'YXZ');
  ajustarTamano();
  camera.updateMatrixWorld();
  actualizarPersonajes(dt);
  composer.render();
  requestAnimationFrame(frame);
}
arrancar();
window.arcade = { yo, maquinas, renderer, composer, abrir, PERSONAJES };  // para depurar desde la consola del navegador
