/*
 * camera.js : phone-driven camera preview with PC movement
 *
 *   index.html          -> PC viewer. Phone rotation drives the view.
 *                          WASD moves, Space jumps, C crouches, R resets.
 *   index.html?sensor   -> Phone sender. Streams the phone's motion sensors
 *                          to the PC viewer.
 */
(function () {
  'use strict';

  // ============================== CONFIG ==============================
  const CONFIG = {
    fov: 75,                 // Default VERTICAL field of view in degrees.
                             // Override per session with ?fov=90 in the URL, or with the +/- keys.
    fovMin: 20,
    fovMax: 120,
    eyeHeight: 6,            // Standing eye height above the ground
    crouchEyeHeight: 3,      // Eye height while crouching (hold C)
    moveSpeed: 14,           // Units per second for WASD
    crouchSpeedFactor: 0.5,  // Movement speed multiplier while crouching
    jumpVelocity: 13,        // Initial upward speed of a jump (jump height is about 2.8 units)
    gravity: 30,             // Downward acceleration while airborne
    mapBound: 95,            // Player cannot leave the area inside this distance from the center
    baseplateSize: 1000,     // Width and length of the baseplate
    gridCellSize: 4,         // Size of one grid square
    baseplateColor: '#2e2e2e',
    gridLineColor: '#4f4f4f',
    skyColor: '#9b9b9b',
    smoothing: 0.35,         // 0 to 1: how fast the view catches up with the phone (1 = no smoothing)
    peerPrefix: 'pcam-',     // Must be identical on both sides
    threeUrl: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    peerUrl: 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'
  };
  // ====================================================================

  const params = new URLSearchParams(window.location.search);
  const isSensor = params.has('sensor');
  const DEG = Math.PI / 180;

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error('Could not load ' + src + '. Check the internet connection.'));
      };
      document.head.appendChild(s);
    });
  }

  function addStyle(css) {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  function showFatal(message) {
    addStyle('html,body{margin:0;height:100%;background:#111;color:#eee;font-family:system-ui,sans-serif}');
    const el = document.createElement('div');
    el.style.cssText = 'padding:24px;font-size:18px;';
    el.textContent = message;
    document.body.appendChild(el);
  }

  // 6-character code without easily confused characters (no 0, 1, i, l, o)
  function makeCode() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint32Array(6);
    crypto.getRandomValues(bytes);
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }
    return code;
  }

  // Current screen rotation in degrees (0, 90, 180, 270)
  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    if (typeof window.orientation === 'number') {
      return window.orientation;
    }
    return 0;
  }

  // =========================== PHONE SENSOR ===========================
  function runSensor() {
    addStyle(
      'html,body{margin:0;height:100%;background:#111;color:#eee;font-family:system-ui,sans-serif}' +
      '#sensor-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;' +
      'height:100%;box-sizing:border-box;padding:24px;text-align:center}' +
      '#sensor-code{font-size:22px;padding:12px;width:100%;max-width:320px;text-align:center;border-radius:8px;' +
      'border:1px solid #555;background:#222;color:#fff;box-sizing:border-box}' +
      '#sensor-start{font-size:18px;padding:12px 28px;border:0;border-radius:8px;background:#fff;color:#111}' +
      '#sensor-start:disabled{opacity:0.5}' +
      '#sensor-status{min-height:3em;max-width:360px}'
    );

    const wrap = document.createElement('div');
    wrap.id = 'sensor-wrap';
    wrap.innerHTML =
      '<h2 style="margin:0">Phone camera sensor</h2>' +
      '<input id="sensor-code" placeholder="Code shown on the PC" autocomplete="off" ' +
      'autocapitalize="off" spellcheck="false">' +
      '<button id="sensor-start">Connect and start</button>' +
      '<div id="sensor-status">Type the code from your PC screen, then tap the button.</div>';
    document.body.appendChild(wrap);

    const codeInput = document.getElementById('sensor-code');
    const startBtn = document.getElementById('sensor-start');
    const statusEl = document.getElementById('sensor-status');
    codeInput.value = (params.get('code') || '').trim();

    function setStatus(text) {
      statusEl.textContent = text;
    }

    function connectToPc(code) {
      setStatus('Connecting to the PC...');
      const peer = new Peer();
      let conn = null;
      let gotData = false;

      function sendOrientation(e) {
        if (!conn || !conn.open) return;
        if (e.alpha === null && e.beta === null && e.gamma === null) return;
        if (!gotData) {
          gotData = true;
          setStatus('Streaming motion to the PC. Keep this page open and the screen on.');
        }
        conn.send({
          a: e.alpha || 0,
          b: e.beta || 0,
          g: e.gamma || 0,
          o: screenAngle()
        });
      }

      peer.on('error', function (err) {
        if (err.type === 'peer-unavailable') {
          setStatus('No PC camera found with that code. Make sure the viewer is open on the PC and the code is correct.');
        } else {
          setStatus('Connection problem: ' + err.type + '. Reload this page and try again.');
        }
        startBtn.disabled = false;
      });

      peer.on('open', function () {
        conn = peer.connect(CONFIG.peerPrefix + code);
        conn.on('open', function () {
          setStatus('Connected to the PC. Waiting for motion data...');
          window.addEventListener('deviceorientation', sendOrientation);
          setTimeout(function () {
            if (!gotData) {
              setStatus('Connected, but no motion data arrived. This device may have no motion sensor, or motion access was not granted.');
            }
          }, 3000);
        });
        conn.on('close', function () {
          window.removeEventListener('deviceorientation', sendOrientation);
          setStatus('Disconnected from the PC. Reload this page to reconnect.');
          startBtn.disabled = false;
        });
      });
    }

    startBtn.addEventListener('click', function () {
      const code = codeInput.value.trim().toLowerCase();
      if (!code) {
        setStatus('Enter the code shown on the PC.');
        return;
      }
      if (typeof DeviceOrientationEvent === 'undefined') {
        setStatus('This browser does not provide motion sensor data.');
        return;
      }

      // iOS requires the permission prompt to come directly from this tap.
      let permission = Promise.resolve('granted');
      try {
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
          permission = DeviceOrientationEvent.requestPermission();
        }
      } catch (err) {
        setStatus('Could not request motion access: ' + err.message);
        return;
      }

      startBtn.disabled = true;
      setStatus('Waiting for motion sensor permission...');
      permission
        .then(function (state) {
          if (state !== 'granted') {
            throw new Error('Motion sensor permission was denied. Reload the page and allow it.');
          }
          connectToPc(code);
        })
        .catch(function (err) {
          startBtn.disabled = false;
          setStatus(err && err.message ? err.message : String(err));
        });
    });
  }

  // ============================ PC VIEWER ============================
  function runViewer() {
    const THREE = window.THREE;

    addStyle(
      'html,body{margin:0;height:100%;overflow:hidden;background:' + CONFIG.skyColor + '}' +
      'canvas{display:block}' +
      '.cam-cross{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#ffffff;' +
      'border:0;box-shadow:none;pointer-events:none}' +
      '#cam-cross-h{width:22px;height:2px}' +
      '#cam-cross-v{width:2px;height:22px}' +
      '#cam-hud{position:fixed;top:10px;left:10px;padding:6px 10px;background:rgba(0,0,0,0.5);color:#fff;' +
      'font:14px/1.4 monospace;white-space:pre;border-radius:6px;pointer-events:none}'
    );

    // ---- renderer and overlay ----
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const crossH = document.createElement('div');
    crossH.id = 'cam-cross-h';
    crossH.className = 'cam-cross';
    const crossV = document.createElement('div');
    crossV.id = 'cam-cross-v';
    crossV.className = 'cam-cross';
    const hud = document.createElement('div');
    hud.id = 'cam-hud';
    document.body.append(crossH, crossV, hud);

    // ---- scene: gray sky, dark-gray baseplate with grid texture ----
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(CONFIG.skyColor);

    const tilePx = 128;
    const gridCanvas = document.createElement('canvas');
    gridCanvas.width = tilePx;
    gridCanvas.height = tilePx;
    const g = gridCanvas.getContext('2d');
    g.fillStyle = CONFIG.baseplateColor;
    g.fillRect(0, 0, tilePx, tilePx);
    g.fillStyle = CONFIG.gridLineColor;
    g.fillRect(0, 0, tilePx, 2);
    g.fillRect(0, 0, 2, tilePx);

    const gridTex = new THREE.CanvasTexture(gridCanvas);
    gridTex.wrapS = THREE.RepeatWrapping;
    gridTex.wrapT = THREE.RepeatWrapping;
    const repeats = CONFIG.baseplateSize / CONFIG.gridCellSize;
    gridTex.repeat.set(repeats, repeats);
    gridTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const baseplate = new THREE.Mesh(
      new THREE.PlaneGeometry(CONFIG.baseplateSize, CONFIG.baseplateSize),
      new THREE.MeshBasicMaterial({ map: gridTex })
    );
    baseplate.rotation.x = -Math.PI / 2;
    scene.add(baseplate);

    // ---- simple geometric map for reference ----
    // Visual only: the player walks through these shapes, they do not block movement.
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(60, 120, 40);
    scene.add(sun);

    (function buildMap() {
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x1a1a1a });

      function add(geometry, color, x, y, z, rotY) {
        const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: color }));
        mesh.position.set(x, y, z);
        if (rotY) mesh.rotation.y = rotY;
        mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMat));
        scene.add(mesh);
      }

      // Box whose bottom sits on the baseplate
      function box(w, h, d, color, x, z) {
        add(new THREE.BoxGeometry(w, h, d), color, x, h / 2, z);
      }

      // Central plinth and tall tower
      box(16, 2, 16, 0xc8c8c8, 0, 0);
      box(6, 30, 6, 0xe0e0e0, 40, 0);

      // Staircase
      for (let i = 0; i < 8; i++) {
        box(4, (i + 1) * 1.5, 4, 0xb0b0b0, -60 + i * 4, -30);
      }

      // Pyramid
      add(new THREE.ConeGeometry(9, 14, 4), 0xd8d8d8, -40, 7, 40, Math.PI / 4);

      // Row of pillars alternating shade
      for (let i = -4; i <= 4; i++) {
        box(4, 12, 4, i % 2 ? 0x8a8a8a : 0xd0d0d0, i * 12, -70);
      }

      // Corner pillars
      box(6, 20, 6, 0x6e6e6e, -80, -80);
      box(6, 20, 6, 0x6e6e6e, 80, -80);
      box(6, 20, 6, 0x6e6e6e, -80, 80);
      box(6, 20, 6, 0x6e6e6e, 80, 80);

      // Boundary walls
      box(200, 6, 2, 0x6b6b6b, 0, -100);
      box(200, 6, 2, 0x6b6b6b, 0, 100);
      box(2, 6, 200, 0x6b6b6b, -100, 0);
      box(2, 6, 200, 0x6b6b6b, 100, 0);

      // Compass poles: red north, gray east, south and west
      function pole(color, x, z) {
        add(new THREE.CylinderGeometry(1, 1, 40, 12), color, x, 20, z);
      }
      pole(0xc0392b, 0, -130);
      pole(0x9e9e9e, 130, 0);
      pole(0x9e9e9e, 0, 130);
      pole(0x9e9e9e, -130, 0);
    })();

    // ---- camera with configurable FOV ----
    let fovDeg = CONFIG.fov;
    const urlFov = parseFloat(params.get('fov'));
    if (Number.isFinite(urlFov)) {
      fovDeg = urlFov;
    }
    fovDeg = clamp(fovDeg, CONFIG.fovMin, CONFIG.fovMax);

    const camera = new THREE.PerspectiveCamera(
      fovDeg,
      window.innerWidth / window.innerHeight,
      0.1,
      5000
    );

    // ---- phone orientation -> camera orientation ----
    // Same math as three.js DeviceOrientationControls.
    const target = new THREE.Quaternion();   // latest phone orientation (identity = looking forward)
    const deviceQuat = new THREE.Quaternion();
    const screenQuat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const qCorrect = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90 degrees around X
    const zAxis = new THREE.Vector3(0, 0, 1);

    function applyPhoneOrientation(m) {
      if (!m || !Number.isFinite(m.a) || !Number.isFinite(m.b) || !Number.isFinite(m.g)) return;
      const o = Number.isFinite(m.o) ? m.o : 0;
      euler.set(m.b * DEG, m.a * DEG, -m.g * DEG, 'YXZ');
      deviceQuat.setFromEuler(euler);
      deviceQuat.multiply(qCorrect);
      deviceQuat.multiply(screenQuat.setFromAxisAngle(zAxis, -o * DEG));
      target.copy(deviceQuat);
    }

    // ---- keyboard movement state ----
    const keys = {};
    const player = { x: 0, z: 0, feetY: 0, vy: 0, grounded: true };
    let eye = CONFIG.eyeHeight;
    const forward = new THREE.Vector3(0, 0, -1);
    const right = new THREE.Vector3(1, 0, 0);
    const tmpDir = new THREE.Vector3();
    let lastTime = performance.now();

    function resetPosition() {
      player.x = 0;
      player.z = 0;
      player.feetY = 0;
      player.vy = 0;
      player.grounded = true;
    }

    function update(now) {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      // Forward and right are flattened onto the ground, following the direction the camera looks.
      camera.getWorldDirection(tmpDir);
      tmpDir.y = 0;
      if (tmpDir.lengthSq() > 1e-6) {
        forward.copy(tmpDir).normalize();
      }
      right.set(-forward.z, 0, forward.x);

      // Horizontal movement
      let mx = 0;
      let mz = 0;
      if (keys.KeyW) { mx += forward.x; mz += forward.z; }
      if (keys.KeyS) { mx -= forward.x; mz -= forward.z; }
      if (keys.KeyD) { mx += right.x; mz += right.z; }
      if (keys.KeyA) { mx -= right.x; mz -= right.z; }
      const len = Math.hypot(mx, mz);
      if (len > 0) {
        const step = CONFIG.moveSpeed * (keys.KeyC ? CONFIG.crouchSpeedFactor : 1) * dt / len;
        player.x = clamp(player.x + mx * step, -CONFIG.mapBound, CONFIG.mapBound);
        player.z = clamp(player.z + mz * step, -CONFIG.mapBound, CONFIG.mapBound);
      }

      // Jump and gravity
      if (keys.Space && player.grounded) {
        player.vy = CONFIG.jumpVelocity;
        player.grounded = false;
      }
      if (!player.grounded) {
        player.vy -= CONFIG.gravity * dt;
        player.feetY += player.vy * dt;
        if (player.feetY <= 0) {
          player.feetY = 0;
          player.vy = 0;
          player.grounded = true;
        }
      }

      // Crouch: eye height eases toward the target
      const eyeTarget = keys.KeyC ? CONFIG.crouchEyeHeight : CONFIG.eyeHeight;
      eye += (eyeTarget - eye) * Math.min(1, dt * 12);

      camera.position.set(player.x, player.feetY + eye, player.z);
    }

    // ---- connection (PeerJS cloud signalling + WebRTC) ----
    const code = makeCode();
    let peerStatus = 'starting';
    let phoneStatus = 'waiting for phone';
    let phoneConn = null;

    function renderHud() {
      hud.textContent =
        'Code: ' + code + '  (enter this on the phone)\n' +
        'Server: ' + peerStatus + '\n' +
        'Phone: ' + phoneStatus + '\n' +
        'Pos: ' + player.x.toFixed(1) + ', ' + (player.feetY + eye).toFixed(1) + ', ' + player.z.toFixed(1) + '\n' +
        'FOV: ' + fovDeg + '  (+ / - to change)\n' +
        'WASD move, Space jump, C crouch, R reset, H hide HUD';
    }

    const peer = new Peer(CONFIG.peerPrefix + code);

    peer.on('open', function () {
      peerStatus = 'ready';
    });

    peer.on('error', function (err) {
      peerStatus = 'error (' + err.type + '), reload this page';
    });

    peer.on('disconnected', function () {
      peerStatus = 'reconnecting';
      if (!peer.destroyed) {
        peer.reconnect();
      }
    });

    peer.on('connection', function (conn) {
      // Only one phone at a time: replace any previous one.
      if (phoneConn) {
        phoneConn.close();
      }
      phoneConn = conn;

      const onReady = function () {
        phoneStatus = 'connected';
      };
      if (conn.open) {
        onReady();
      } else {
        conn.on('open', onReady);
      }

      conn.on('data', applyPhoneOrientation);

      conn.on('close', function () {
        if (phoneConn === conn) {
          phoneConn = null;
          phoneStatus = 'disconnected (view holds last position)';
        }
      });
    });

    // ---- controls ----
    function setFov(value) {
      fovDeg = clamp(value, CONFIG.fovMin, CONFIG.fovMax);
      camera.fov = fovDeg;
      camera.updateProjectionMatrix();
    }

    window.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      keys[e.code] = true;
      if (e.code === 'Space') {
        e.preventDefault();
      }
      if (e.code === 'KeyR') {
        resetPosition();
      }
      if (e.key === '+' || e.key === '=') {
        setFov(fovDeg + 1);
      } else if (e.key === '-' || e.key === '_') {
        setFov(fovDeg - 1);
      } else if (e.key === 'h' || e.key === 'H') {
        hud.style.display = hud.style.display === 'none' ? '' : 'none';
      }
    });

    window.addEventListener('keyup', function (e) {
      keys[e.code] = false;
    });

    // Release all keys when the window loses focus, so nothing gets stuck.
    window.addEventListener('blur', function () {
      for (const k in keys) {
        keys[k] = false;
      }
    });

    window.addEventListener('resize', function () {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    });

    // ---- render loop ----
    function frame(now) {
      update(now);
      camera.quaternion.slerp(target, CONFIG.smoothing);
      renderer.render(scene, camera);
      renderHud();
      requestAnimationFrame(frame);
    }

    camera.fov = fovDeg;
    camera.updateProjectionMatrix();
    requestAnimationFrame(frame);
  }

  // ================================ START ================================
  async function main() {
    if (document.readyState === 'loading') {
      await new Promise(function (resolve) {
        document.addEventListener('DOMContentLoaded', resolve);
      });
    }
    try {
      if (isSensor) {
        await loadScript(CONFIG.peerUrl);
        runSensor();
      } else {
        await loadScript(CONFIG.threeUrl);
        await loadScript(CONFIG.peerUrl);
        runViewer();
      }
    } catch (err) {
      showFatal(err && err.message ? err.message : String(err));
    }
  }

  main();
})();
