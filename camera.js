/*
 * camera.js : phone-driven camera animation suite
 *
 *   index.html          -> Animation suite. The phone (or mouse) turns the camera,
 *                          WASD / Space / C move it, and the timeline records and
 *                          plays back the CAMERA only.
 *   index.html?sensor   -> Phone sender. Streams the phone's motion sensors.
 *
 * PC shortcuts
 *   WASD move   Space jump   C (hold) crouch   R reset position
 *   T timeline  P play/pause   B record   K add keyframe   Delete remove keyframe
 *   L loop      Home start   Left/Right step one frame   +/- FOV   H hide HUD
 *   Left-drag to look around (only when no phone is connected)
 */
(function () {
  'use strict';

  // ============================== CONFIG ==============================
  const CONFIG = {
    fov: 75,                 // Default VERTICAL field of view in degrees (?fov=90 overrides)
    fovMin: 20,
    fovMax: 120,
    eyeHeight: 6,            // Standing eye height above the ground
    crouchEyeHeight: 3,      // Eye height while crouching (hold C)
    moveSpeed: 14,           // Units per second for WASD
    crouchSpeedFactor: 0.5,  // Speed multiplier while crouching
    jumpVelocity: 13,        // Initial jump speed (jump height is about 2.8 units)
    gravity: 30,
    mapBound: 95,            // The player stays inside this distance from the center
    baseplateSize: 1000,
    gridCellSize: 4,
    baseplateColor: '#2e2e2e',
    gridLineColor: '#4f4f4f',
    skyColor: '#9b9b9b',
    smoothing: 0.35,         // 0 to 1: how fast the view catches up with the phone (1 = no smoothing)
    sensitivity: 1,          // Phone rotation sensitivity (1 = normal)
    sensitivityMin: 0.2,
    sensitivityMax: 3,
    mouseLookSpeed: 0.2,     // Degrees of look per pixel dragged
    recordInterval: 0.1,     // Seconds between recorded camera samples
    defaultFps: 30,          // Playback step and Roblox sample rate (30 or 60)
    defaultEasingStyle: 'Linear',
    defaultEasingDir: 'InOut',
    timelinePxPerSecond: 80, // Default timeline zoom
    peerPrefix: 'pcam-',     // Must be identical on both sides
    threeUrl: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    peerUrl: 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'
  };
  // ====================================================================

  // Camera channels stored in every keyframe
  const CHANNELS = ['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'fov'];
  const CHANNEL_LABELS = { x: 'X', y: 'Y', z: 'Z', pitch: 'Pitch', yaw: 'Yaw', roll: 'Roll', fov: 'FOV' };
  const ANGLE_CHANNELS = ['pitch', 'yaw', 'roll'];
  const CHANNEL_DEFAULTS = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, fov: 75 };
  // Same easing names as Roblox's EasingStyle and EasingDirection
  const EASING_STYLES = ['Linear', 'Constant', 'Sine', 'Quad', 'Cubic', 'Quart', 'Quint',
    'Exponential', 'Circular', 'Back', 'Elastic', 'Bounce'];
  const EASING_DIRS = ['In', 'Out', 'InOut'];

  const DEG = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;

  const params = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
  const isSensor = params.has('sensor');

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
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

  // ======================= ANIMATION MATH (pure) =======================
  // These functions have no DOM or THREE dependency, so they can be tested with Node.

  // Shortest signed difference between two angles in degrees, in [-180, 180)
  function wrapDelta(d) {
    return ((((d + 180) % 360) + 360) % 360) - 180;
  }

  // Makes p's angles continuous with ref, so an interpolation never spins the long way round
  function unwrapPose(p, ref) {
    if (!ref) return p;
    for (const ch of ANGLE_CHANNELS) {
      p[ch] = ref[ch] + wrapDelta(p[ch] - ref[ch]);
    }
    return p;
  }

  function bounceOut(x) {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) { x -= 1.5 / d1; return n1 * x * x + 0.75; }
    if (x < 2.5 / d1) { x -= 2.25 / d1; return n1 * x * x + 0.9375; }
    x -= 2.625 / d1;
    return n1 * x * x + 0.984375;
  }

  // "In" curve for each style, u in [0, 1]
  function easeIn(style, u) {
    switch (style) {
      case 'Sine': return 1 - Math.cos((u * Math.PI) / 2);
      case 'Quad': return u * u;
      case 'Cubic': return u * u * u;
      case 'Quart': return Math.pow(u, 4);
      case 'Quint': return Math.pow(u, 5);
      case 'Exponential': return u === 0 ? 0 : Math.pow(2, 10 * u - 10);
      case 'Circular': return 1 - Math.sqrt(1 - u * u);
      case 'Back': {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return c3 * u * u * u - c1 * u * u;
      }
      case 'Elastic': {
        if (u === 0 || u === 1) return u;
        return -Math.pow(2, 10 * u - 10) * Math.sin((u * 10 - 10.75) * ((2 * Math.PI) / 3));
      }
      case 'Bounce': return 1 - bounceOut(1 - u);
      default: return u;
    }
  }

  // Full easing (style + direction). Constant holds the start value until the segment ends.
  function applyEasing(style, dir, u) {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    if (style === 'Constant') return 0;
    if (style === 'Linear') return u;
    if (dir === 'Out') return 1 - easeIn(style, 1 - u);
    if (dir === 'InOut') {
      return u < 0.5 ? easeIn(style, u * 2) / 2 : 1 - easeIn(style, (1 - u) * 2) / 2;
    }
    return easeIn(style, u);
  }

  // Copies a raw object into a clean keyframe with defaults for anything missing or invalid
  function normalizeKey(raw) {
    const r = raw || {};
    const k = { t: isNum(r.t) ? Math.max(0, r.t) : 0 };
    for (const ch of CHANNELS) {
      k[ch] = isNum(r[ch]) ? r[ch] : CHANNEL_DEFAULTS[ch];
    }
    k.style = EASING_STYLES.indexOf(r.style) !== -1 ? r.style : CONFIG.defaultEasingStyle;
    k.dir = EASING_DIRS.indexOf(r.dir) !== -1 ? r.dir : CONFIG.defaultEasingDir;
    return k;
  }

  function poseOf(k) {
    const p = {};
    for (const ch of CHANNELS) p[ch] = k[ch];
    return p;
  }

  // Camera pose at time t. Keys must be sorted by t.
  function evaluateTimeline(keys, t) {
    if (!keys.length) return null;
    if (t <= keys[0].t) return poseOf(keys[0]);
    const last = keys[keys.length - 1];
    if (t >= last.t) return poseOf(last);
    let i = 0;
    while (keys[i + 1].t <= t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const span = b.t - a.t;
    if (span < 1e-9) return poseOf(b);
    const e = applyEasing(a.style, a.dir, (t - a.t) / span);
    const p = {};
    for (const ch of CHANNELS) {
      p[ch] = a[ch] + (b[ch] - a[ch]) * e;
    }
    return p;
  }

  // Samples the timeline at fps, plus every keyframe time. Used for the Roblox export,
  // so every easing (which Roblox pose easing does not offer) is baked into linear steps.
  function bakeTimeline(keys, fps) {
    if (!keys.length) return [];
    const end = keys[keys.length - 1].t;
    const times = [];
    const steps = Math.ceil(end * fps - 1e-9);
    for (let n = 0; n <= steps; n++) {
      times.push(Math.min(n / fps, end));
    }
    for (const k of keys) times.push(k.t);
    times.sort(function (a, b) { return a - b; });
    const out = [];
    for (const t of times) {
      if (out.length && t - out[out.length - 1].t < 1e-6) continue;
      out.push({ t: t, pose: evaluateTimeline(keys, t) });
    }
    return out;
  }

  // Builds the Roblox Luau script. The root moves and turns with the camera,
  // and the head follows pitch and roll. All values are relative to the first frame.
  function buildLuau(baked, opts) {
    const rig = opts.rig === 'R6' ? 'R6' : 'R15';
    const chain = rig === 'R6' ? ['Torso', 'Head'] : ['LowerTorso', 'UpperTorso', 'Head'];
    const ref = baked[0].pose;
    const s = opts.scale;
    const fmt = function (n) { return Number(n).toFixed(4); };
    const rows = baked.map(function (b) {
      const p = b.pose;
      const vals = [b.t, (p.x - ref.x) * s, (p.y - ref.y) * s, (p.z - ref.z) * s,
        p.yaw - ref.yaw, p.pitch - ref.pitch, p.roll - ref.roll];
      return '\t{' + vals.map(fmt).join(', ') + '},';
    });
    const chainLua = chain.map(function (n) { return '"' + n + '"'; }).join(', ');
    const head = [
      '-- Camera animation exported from the Camera Animation Suite.',
      '-- Rig: ' + rig + '   Keyframes: ' + baked.length + '   Duration: ' + opts.duration.toFixed(2) +
        ' s   Sample rate: ' + opts.fps + ' fps',
      '-- The root moves with the camera offset from its starting point and turns with its yaw.',
      '-- The head follows the camera pitch and roll. FOV has no rig equivalent and is not exported.',
      '-- Units: studs (scale ' + s + '). Times are in seconds.',
      '--',
      '-- Put this in a Script (for example in ServerScriptService). When the game starts it builds',
      '-- the KeyframeSequence in ReplicatedStorage. The commented block at the bottom plays it on a rig.',
      '',
      'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
      '',
      'local SEQUENCE_NAME = "CameraAnimation"',
      'local ROOT_NAME = "HumanoidRootPart"',
      'local CHAIN = {' + chainLua + '}',
      '',
      '-- { time, dx, dy, dz, yaw (deg), pitch (deg), roll (deg) }',
      'local DATA = {'
    ];
    const tail = [
      '}',
      '',
      'local sequence = Instance.new("KeyframeSequence")',
      'sequence.Name = SEQUENCE_NAME',
      '',
      'for _, row in ipairs(DATA) do',
      '\tlocal keyframe = Instance.new("Keyframe")',
      '\tkeyframe.Time = row[1]',
      '',
      '\tlocal root = Instance.new("Pose")',
      '\troot.Name = ROOT_NAME',
      '\troot.CFrame = CFrame.new(row[2], row[3], row[4]) * CFrame.Angles(0, math.rad(row[5]), 0)',
      '\troot.Parent = keyframe',
      '',
      '\tlocal parent = root',
      '\tfor i, jointName in ipairs(CHAIN) do',
      '\t\tlocal pose = Instance.new("Pose")',
      '\t\tpose.Name = jointName',
      '\t\tif i == #CHAIN then',
      '\t\t\tpose.CFrame = CFrame.Angles(math.rad(row[6]), 0, math.rad(row[7]))',
      '\t\telse',
      '\t\t\tpose.CFrame = CFrame.new()',
      '\t\tend',
      '\t\tpose.Parent = parent',
      '\t\tparent = pose',
      '\tend',
      '',
      '\tkeyframe.Parent = sequence',
      'end',
      '',
      'sequence.Parent = ReplicatedStorage',
      '',
      '--[[ Play it on a rig (in a Script or LocalScript; rig = your character model):',
      'local humanoid = rig:WaitForChild("Humanoid")',
      'local animator = humanoid:FindFirstChildOfClass("Animator") or Instance.new("Animator", humanoid)',
      'local animation = Instance.new("Animation")',
      'animation.AnimationId = game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(sequence)',
      'local track = animator:LoadAnimation(animation)',
      'track.Looped = false',
      'track:Play()',
      ']]',
      ''
    ];
    return head.concat(rows, tail).join('\n');
  }

  // ============================== PHONE SENSOR ==============================
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

  // ============================== PC ANIMATION SUITE ==============================
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
      'font:13px/1.4 monospace;white-space:pre;border-radius:6px;pointer-events:none}' +
      '#tl{position:fixed;left:0;right:0;bottom:0;background:rgba(24,24,24,0.95);color:#ddd;' +
      'font:12px system-ui,sans-serif;display:flex;flex-direction:column;border-top:1px solid #444;' +
      'user-select:none;z-index:10}' +
      '#tl.hidden{display:none}' +
      '#tl-bar{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #333;flex-wrap:wrap}' +
      '#tl-bar button{background:#333;color:#eee;border:1px solid #555;border-radius:4px;padding:4px 8px;cursor:pointer}' +
      '#tl-bar button:hover{background:#444}' +
      '#tl-bar button.active{background:#8b1d1d;border-color:#c33}' +
      '#tl-bar label{display:flex;align-items:center;gap:4px}' +
      '#tl-time{font-family:monospace;min-width:130px}' +
      '#tl-status{color:#9fd39f;margin-left:auto}' +
      '#tl-body{display:flex;height:204px}' +
      '#tl-labels{width:70px;flex:none;border-right:1px solid #333}' +
      '#tl-labels>div{box-sizing:border-box;height:26px;line-height:24px;padding-left:8px;color:#aaa;' +
      'border-bottom:1px solid #2a2a2a}' +
      '#tl-labels>.spacer{height:22px;border-bottom:1px solid #333}' +
      '#tl-scroll{flex:1;overflow-x:auto;overflow-y:hidden;position:relative}' +
      '#tl-content{position:relative;height:204px}' +
      '.tl-ruler{position:relative;height:22px;box-sizing:border-box;border-bottom:1px solid #333;background:#1d1d1d}' +
      '.tl-tick{position:absolute;top:0;height:22px;border-left:1px solid #555;padding-left:3px;color:#888;' +
      'font-size:11px;line-height:22px;pointer-events:none}' +
      '.tl-row{position:relative;height:26px;box-sizing:border-box;border-bottom:1px solid #2a2a2a}' +
      '.tl-key{position:absolute;top:8px;width:9px;height:9px;margin-left:-4px;background:#e8c04a;' +
      'transform:rotate(45deg);cursor:pointer;border:1px solid #111}' +
      '.tl-key.sel{background:#ff7a1a;box-shadow:0 0 0 2px #fff}' +
      '#tl-playhead{position:absolute;top:0;width:1px;background:#ff5555;pointer-events:none;z-index:2}' +
      '#tl-props{display:flex;align-items:center;gap:10px;padding:6px 8px;border-top:1px solid #333;flex-wrap:wrap}' +
      '#tl-props input,#tl-props select,#tl-bar select,#tl-bar input[type=number]{background:#222;color:#eee;' +
      'border:1px solid #555;border-radius:4px;padding:2px 4px}' +
      '#tl-props input[type=number]{width:72px}' +
      '#tl-props input:disabled,#tl-props select:disabled{opacity:0.4}' +
      '#tl-file{display:none}'
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

    // ---- geometric reference map (visual only, does not block movement) ----
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

      box(16, 2, 16, 0xc8c8c8, 0, 0);          // central plinth
      box(6, 30, 6, 0xe0e0e0, 40, 0);          // tall tower

      for (let i = 0; i < 8; i++) {            // staircase
        box(4, (i + 1) * 1.5, 4, 0xb0b0b0, -60 + i * 4, -30);
      }

      add(new THREE.ConeGeometry(9, 14, 4), 0xd8d8d8, -40, 7, 40, Math.PI / 4); // pyramid

      for (let i = -4; i <= 4; i++) {          // pillar row, alternating shade
        box(4, 12, 4, i % 2 ? 0x8a8a8a : 0xd0d0d0, i * 12, -70);
      }

      box(6, 20, 6, 0x6e6e6e, -80, -80);       // corner pillars
      box(6, 20, 6, 0x6e6e6e, 80, -80);
      box(6, 20, 6, 0x6e6e6e, -80, 80);
      box(6, 20, 6, 0x6e6e6e, 80, 80);

      box(200, 6, 2, 0x6b6b6b, 0, -100);       // boundary walls
      box(200, 6, 2, 0x6b6b6b, 0, 100);
      box(2, 6, 200, 0x6b6b6b, -100, 0);
      box(2, 6, 200, 0x6b6b6b, 100, 0);

      function pole(color, x, z) {             // compass poles: red north
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

    const camera = new THREE.PerspectiveCamera(fovDeg, window.innerWidth / window.innerHeight, 0.1, 5000);

    // ---- phone and mouse orientation ----
    const phoneTarget = new THREE.Quaternion();   // latest phone orientation (identity = forward)
    const deviceQuat = new THREE.Quaternion();
    const screenQuat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const qCorrect = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90 degrees around X
    const zAxis = new THREE.Vector3(0, 0, 1);
    const scaledTarget = new THREE.Quaternion();
    const liveTarget = new THREE.Quaternion();
    const lookEuler = { pitch: 0, yaw: 0, roll: 0 };  // used when no phone is connected
    let phoneLive = false;
    let sensitivity = clamp(CONFIG.sensitivity, CONFIG.sensitivityMin, CONFIG.sensitivityMax);

    function applyPhoneOrientation(m) {
      if (!m || !isNum(m.a) || !isNum(m.b) || !isNum(m.g)) return;
      const o = isNum(m.o) ? m.o : 0;
      euler.set(m.b * DEG, m.a * DEG, -m.g * DEG, 'YXZ');
      deviceQuat.setFromEuler(euler);
      deviceQuat.multiply(qCorrect);
      deviceQuat.multiply(screenQuat.setFromAxisAngle(zAxis, -o * DEG));
      phoneTarget.copy(deviceQuat);
    }

    // Copies the camera's current rotation into lookEuler (used when the phone disconnects)
    function syncLookFromCamera() {
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      lookEuler.pitch = e.x * RAD2DEG;
      lookEuler.yaw = e.y * RAD2DEG;
      lookEuler.roll = e.z * RAD2DEG;
    }

    // ---- live movement state (WASD, jump, crouch) ----
    const held = {};
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

    // Live control: movement and orientation from the keyboard, phone or mouse
    function updateLive(dt) {
      camera.getWorldDirection(tmpDir);
      tmpDir.y = 0;
      if (tmpDir.lengthSq() > 1e-6) {
        forward.copy(tmpDir).normalize();
      }
      right.set(-forward.z, 0, forward.x);

      let mx = 0;
      let mz = 0;
      if (held.KeyW) { mx += forward.x; mz += forward.z; }
      if (held.KeyS) { mx -= forward.x; mz -= forward.z; }
      if (held.KeyD) { mx += right.x; mz += right.z; }
      if (held.KeyA) { mx -= right.x; mz -= right.z; }
      const len = Math.hypot(mx, mz);
      if (len > 0) {
        const step = CONFIG.moveSpeed * (held.KeyC ? CONFIG.crouchSpeedFactor : 1) * dt / len;
        player.x = clamp(player.x + mx * step, -CONFIG.mapBound, CONFIG.mapBound);
        player.z = clamp(player.z + mz * step, -CONFIG.mapBound, CONFIG.mapBound);
      }

      if (held.Space && player.grounded) {
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

      const eyeTarget = held.KeyC ? CONFIG.crouchEyeHeight : CONFIG.eyeHeight;
      eye += (eyeTarget - eye) * Math.min(1, dt * 12);

      if (phoneLive) {
        scaledTarget.set(0, 0, 0, 1);
        scaledTarget.slerp(phoneTarget, sensitivity);
      } else {
        liveTarget.setFromEuler(new THREE.Euler(lookEuler.pitch * DEG, lookEuler.yaw * DEG,
          lookEuler.roll * DEG, 'YXZ'));
        scaledTarget.copy(liveTarget);
      }
      camera.quaternion.slerp(scaledTarget, CONFIG.smoothing);
      camera.position.set(player.x, player.feetY + eye, player.z);
    }

    // ---- camera pose helpers ----
    function cameraPose() {
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      return {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        pitch: e.x * RAD2DEG,
        yaw: e.y * RAD2DEG,
        roll: e.z * RAD2DEG,
        fov: camera.fov
      };
    }

    // Moves the camera to a pose and keeps live control in sync with it
    function setCameraFromPose(p) {
      camera.position.set(p.x, p.y, p.z);
      camera.quaternion.setFromEuler(new THREE.Euler(p.pitch * DEG, p.yaw * DEG, p.roll * DEG, 'YXZ'));
      if (camera.fov !== p.fov) {
        camera.fov = p.fov;
        camera.updateProjectionMatrix();
      }
      fovDeg = p.fov;
      lookEuler.pitch = p.pitch;
      lookEuler.yaw = p.yaw;
      lookEuler.roll = p.roll;
      player.x = p.x;
      player.z = p.z;
      player.feetY = Math.max(0, p.y - eye);
      player.vy = 0;
      player.grounded = player.feetY <= 0.0001;
    }

    // ---- timeline state ----
    let keys = [];                 // keyframes, sorted by t
    let selected = null;           // selected keyframe object
    let time = 0;                  // playhead, seconds
    let playing = false;
    let recording = false;
    let pxPerSec = CONFIG.timelinePxPerSecond;
    let timelineDirty = true;
    let lastTimelineRender = 0;
    let recStart = 0;
    let recSamples = [];
    let recRef = null;
    let lastSampleT = -Infinity;
    let drag = null;

    function duration() {
      return keys.length ? keys[keys.length - 1].t : 0;
    }

    function sortKeys() {
      keys.sort(function (a, b) { return a.t - b.t; });
    }

    function makeKey(t, p, style, dir) {
      const k = { t: t, style: style, dir: dir };
      for (const ch of CHANNELS) k[ch] = p[ch];
      return k;
    }

    // Last keyframe at or before t
    function prevKeyBefore(t) {
      let r = null;
      for (const k of keys) {
        if (k.t <= t + 1e-9) r = k;
        else break;
      }
      return r;
    }

    function applyPoseAt(t) {
      const p = evaluateTimeline(keys, t);
      if (p) setCameraFromPose(p);
    }

    function setStatus(text) {
      ui.status.textContent = text;
    }

    function fmtTime(t) {
      const m = Math.floor(t / 60);
      const s = (t - m * 60).toFixed(2).padStart(5, '0');
      return String(m).padStart(2, '0') + ':' + s;
    }

    // ---- timeline panel DOM ----
    const tl = document.createElement('div');
    tl.id = 'tl';
    function opts(list, sel) {
      return list.map(function (v) {
        return '<option' + (v === sel ? ' selected' : '') + '>' + v + '</option>';
      }).join('');
    }
    const propInputs = CHANNELS.map(function (ch) {
      return '<label>' + CHANNEL_LABELS[ch] + ' <input type="number" step="0.1" id="pr-' + ch + '"></label>';
    }).join('');
    tl.innerHTML =
      '<div id="tl-bar">' +
        '<button data-act="record" id="tl-rec">Record</button>' +
        '<button data-act="play" id="tl-play">Play</button>' +
        '<button data-act="home">Start</button>' +
        '<label><input type="checkbox" id="tl-loop"> Loop</label>' +
        '<button data-act="addkey">+ Key (K)</button>' +
        '<button data-act="delkey">Delete Key</button>' +
        '<span id="tl-time">00:00.00 / 00:00.00</span>' +
        '<label>Zoom <input type="range" id="tl-zoom" min="20" max="300" step="5" value="' + pxPerSec + '"></label>' +
        '<label>Sensitivity <input type="range" id="cam-sens-slider" min="' + CONFIG.sensitivityMin +
          '" max="' + CONFIG.sensitivityMax + '" step="0.05" value="' + sensitivity + '">' +
          '<span id="cam-sens-value"></span></label>' +
        '<button data-act="save">Save JSON</button>' +
        '<button data-act="load">Load JSON</button>' +
        '<input type="file" id="tl-file" accept=".json,application/json">' +
        '<label>Rig <select id="tl-rig">' + opts(['R15', 'R6'], 'R15') + '</select></label>' +
        '<label>FPS <select id="tl-fps">' + opts(['30', '60'], String(CONFIG.defaultFps)) + '</select></label>' +
        '<button data-act="export">Export Roblox .lua</button>' +
        '<button data-act="hide">Hide (T)</button>' +
        '<span id="tl-status"></span>' +
      '</div>' +
      '<div id="tl-body">' +
        '<div id="tl-labels"></div>' +
        '<div id="tl-scroll"><div id="tl-content"></div></div>' +
      '</div>' +
      '<div id="tl-props">' +
        '<span>Selected key:</span>' +
        '<label>Time <input type="number" step="0.05" min="0" id="pr-t"></label>' +
        '<label>Style <select id="pr-style">' + opts(EASING_STYLES, CONFIG.defaultEasingStyle) + '</select></label>' +
        '<label>Direction <select id="pr-dir">' + opts(EASING_DIRS, CONFIG.defaultEasingDir) + '</select></label>' +
        propInputs +
      '</div>';
    document.body.appendChild(tl);

    const ui = {
      rec: tl.querySelector('#tl-rec'),
      play: tl.querySelector('#tl-play'),
      loop: tl.querySelector('#tl-loop'),
      time: tl.querySelector('#tl-time'),
      zoom: tl.querySelector('#tl-zoom'),
      sensSlider: tl.querySelector('#cam-sens-slider'),
      sensValue: tl.querySelector('#cam-sens-value'),
      status: tl.querySelector('#tl-status'),
      file: tl.querySelector('#tl-file'),
      rig: tl.querySelector('#tl-rig'),
      fps: tl.querySelector('#tl-fps'),
      labels: tl.querySelector('#tl-labels'),
      scroll: tl.querySelector('#tl-scroll'),
      content: tl.querySelector('#tl-content'),
      pr: {
        t: tl.querySelector('#pr-t'),
        style: tl.querySelector('#pr-style'),
        dir: tl.querySelector('#pr-dir')
      }
    };
    CHANNELS.forEach(function (ch) {
      ui.pr[ch] = tl.querySelector('#pr-' + ch);
    });
    const propAll = [ui.pr.t, ui.pr.style, ui.pr.dir].concat(CHANNELS.map(function (ch) { return ui.pr[ch]; }));

    ui.labels.innerHTML = '<div class="spacer"></div>' + CHANNELS.map(function (ch) {
      return '<div>' + CHANNEL_LABELS[ch] + '</div>';
    }).join('');

    let playheadEl = document.createElement('div');
    playheadEl.id = 'tl-playhead';
    playheadEl.style.height = (22 + CHANNELS.length * 26) + 'px';

    // ---- sensitivity ----
    function setSensitivity(value) {
      sensitivity = clamp(value, CONFIG.sensitivityMin, CONFIG.sensitivityMax);
      ui.sensSlider.value = sensitivity;
      ui.sensValue.textContent = sensitivity.toFixed(2) + 'x';
    }
    setSensitivity(sensitivity);
    ui.sensSlider.addEventListener('input', function () {
      setSensitivity(parseFloat(ui.sensSlider.value));
    });
    ui.sensSlider.addEventListener('change', function () {
      ui.sensSlider.blur();
    });

    // ---- timeline rendering ----
    function updatePlayhead() {
      playheadEl.style.left = (time * pxPerSec) + 'px';
      if (playing || recording) {
        const x = time * pxPerSec;
        const sc = ui.scroll;
        if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 30) {
          sc.scrollLeft = Math.max(0, x - 40);
        }
      }
    }

    function updateTimeLabel() {
      ui.time.textContent = fmtTime(time) + ' / ' + fmtTime(duration());
    }

    function updateButtons() {
      ui.rec.classList.toggle('active', recording);
      ui.rec.textContent = recording ? 'Stop Rec' : 'Record';
      ui.play.textContent = playing ? 'Pause' : 'Play';
    }

    function renderProps() {
      const has = !!selected;
      propAll.forEach(function (el) { el.disabled = !has; });
      if (!has) {
        propAll.forEach(function (el) { el.value = ''; });
        return;
      }
      ui.pr.t.value = selected.t.toFixed(2);
      ui.pr.style.value = selected.style;
      ui.pr.dir.value = selected.dir;
      CHANNELS.forEach(function (ch) {
        ui.pr[ch].value = Number(selected[ch]).toFixed(2);
      });
    }

    function renderTimeline() {
      timelineDirty = false;
      lastTimelineRender = performance.now();
      const dur = Math.max(10, duration() + 2);
      const width = Math.ceil(dur * pxPerSec);
      const content = ui.content;
      content.textContent = '';
      content.style.width = width + 'px';

      const ruler = document.createElement('div');
      ruler.className = 'tl-ruler';
      ruler.style.width = width + 'px';
      for (let s = 0; s <= Math.floor(dur); s++) {
        const tick = document.createElement('div');
        tick.className = 'tl-tick';
        tick.style.left = (s * pxPerSec) + 'px';
        tick.textContent = s + 's';
        ruler.appendChild(tick);
      }
      content.appendChild(ruler);

      CHANNELS.forEach(function (ch) {
        const row = document.createElement('div');
        row.className = 'tl-row';
        row.style.width = width + 'px';
        row.dataset.channel = ch;
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const d = document.createElement('div');
          d.className = 'tl-key' + (k === selected ? ' sel' : '');
          d.dataset.idx = String(i);
          d.style.left = (k.t * pxPerSec) + 'px';
          row.appendChild(d);
        }
        content.appendChild(row);
      });

      content.appendChild(playheadEl);
      updatePlayhead();
      updateTimeLabel();
      renderProps();
    }

    function moveKeyElements(i) {
      const k = keys[i];
      ui.content.querySelectorAll('.tl-key[data-idx="' + i + '"]').forEach(function (d) {
        d.style.left = (k.t * pxPerSec) + 'px';
      });
    }

    function setTime(t) {
      if (recording) return;
      time = Math.max(0, t);
      if (!playing && keys.length) applyPoseAt(time);
      updatePlayhead();
      updateTimeLabel();
    }

    function selectKey(k) {
      selected = k;
      renderTimeline();
      setTime(k.t);
    }

    function deleteSelected() {
      if (recording || !selected) return;
      keys = keys.filter(function (k) { return k !== selected; });
      selected = null;
      renderTimeline();
      setStatus('Keyframe deleted.');
    }

    // Adds a keyframe with the current camera pose at the playhead
    function addKeyAtTime() {
      if (recording) return;
      const t = time;
      const p = cameraPose();
      unwrapPose(p, prevKeyBefore(t));
      let style = CONFIG.defaultEasingStyle;
      let dir = CONFIG.defaultEasingDir;
      const existing = keys.find(function (k) { return Math.abs(k.t - t) < 1e-3; });
      if (existing) {
        style = existing.style;
        dir = existing.dir;
        keys.splice(keys.indexOf(existing), 1);
      }
      const k = makeKey(t, p, style, dir);
      keys.push(k);
      sortKeys();
      selected = k;
      renderTimeline();
      setStatus('Keyframe added at ' + fmtTime(t) + '.');
    }

    function togglePlay() {
      if (recording) return;
      if (!keys.length) {
        setStatus('Add keyframes first (K), or record (B).');
        return;
      }
      if (!playing && time >= duration()) time = 0;
      playing = !playing;
      setStatus(playing ? 'Playing...' : 'Paused.');
      updateButtons();
    }

    function stepTime(dir) {
      if (recording) return;
      playing = false;
      const fps = Number(ui.fps.value) || CONFIG.defaultFps;
      setTime(Math.max(0, Math.round(time * fps) / fps + dir / fps));
      updateButtons();
    }

    // Records the camera only. Samples are stored as keyframes when you stop.
    function toggleRecord() {
      if (recording) {
        finishRecording();
        return;
      }
      playing = false;
      recording = true;
      recStart = time;
      recSamples = [];
      recRef = prevKeyBefore(recStart);
      lastSampleT = -Infinity;
      updateButtons();
      setStatus('Recording the camera. Press Record again to stop.');
    }

    function recordSample() {
      if (time - lastSampleT < CONFIG.recordInterval - 1e-9) return;
      lastSampleT = time;
      const p = cameraPose();
      const prev = recSamples.length ? recSamples[recSamples.length - 1] : recRef;
      unwrapPose(p, prev);
      recSamples.push(makeKey(time, p, 'Linear', 'InOut'));
    }

    function finishRecording() {
      recording = false;
      const end = time;
      if (recSamples.length) {
        const last = recSamples[recSamples.length - 1];
        if (last.t < end - 1e-6) {
          const p = cameraPose();
          unwrapPose(p, last);
          recSamples.push(makeKey(end, p, 'Linear', 'InOut'));
        }
      } else {
        const p = cameraPose();
        unwrapPose(p, recRef);
        recSamples.push(makeKey(recStart, p, 'Linear', 'InOut'));
      }
      // Replace existing keys inside the recorded range
      keys = keys.filter(function (k) {
        return k.t < recStart - 1e-6 || k.t > end + 1e-6;
      }).concat(recSamples);
      sortKeys();
      selected = null;
      recSamples = [];
      updateButtons();
      renderTimeline();
      setStatus('Recorded ' + keys.length + ' keyframes in total.');
    }

    function downloadText(text, name, mime) {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function exportLua() {
      if (!keys.length) {
        setStatus('Nothing to export: add keyframes first.');
        return;
      }
      const fps = Number(ui.fps.value) || CONFIG.defaultFps;
      const baked = bakeTimeline(keys, fps);
      const lua = buildLuau(baked, {
        rig: ui.rig.value,
        scale: 1,
        fps: fps,
        duration: duration()
      });
      downloadText(lua, 'CameraAnimation.lua', 'text/plain');
      setStatus('Exported ' + baked.length + ' frames for ' + ui.rig.value + '.');
    }

    function saveJson() {
      const data = { format: 'camera-animation', version: 1, keys: keys.map(normalizeKey) };
      downloadText(JSON.stringify(data, null, 2), 'camera-animation.json', 'application/json');
      setStatus('Saved ' + keys.length + ' keyframes.');
    }

    function loadProjectText(text) {
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (err) {
        setStatus('That file is not valid JSON.');
        return;
      }
      if (!data || data.format !== 'camera-animation' || !Array.isArray(data.keys)) {
        setStatus('That file is not a camera animation.');
        return;
      }
      keys = data.keys.map(normalizeKey);
      sortKeys();
      selected = null;
      playing = false;
      setTime(0);
      renderTimeline();
      updateButtons();
      setStatus('Loaded ' + keys.length + ' keyframes.');
    }

    // ---- timeline interaction ----
    function xToTime(clientX) {
      const r = ui.scroll.getBoundingClientRect();
      return Math.max(0, (clientX - r.left + ui.scroll.scrollLeft) / pxPerSec);
    }

    function snapTime(t) {
      return Math.round(t * 20) / 20;
    }

    ui.content.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target.classList.contains('tl-key')) {
        const k = keys[Number(e.target.dataset.idx)];
        drag = { kind: 'key', key: k, index: keys.indexOf(k), startX: e.clientX, origT: k.t, moved: false };
        selectKey(k);
      } else {
        drag = { kind: 'scrub' };
        setTime(xToTime(e.clientX));
      }
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      if (drag.kind === 'scrub') {
        setTime(xToTime(e.clientX));
        return;
      }
      const nt = snapTime(Math.max(0, drag.origT + (e.clientX - drag.startX) / pxPerSec));
      drag.key.t = nt;
      drag.moved = true;
      moveKeyElements(keys.indexOf(drag.key));
      setTime(nt);
    });

    window.addEventListener('mouseup', function () {
      if (drag && drag.kind === 'key' && drag.moved) {
        sortKeys();
        renderTimeline();
      }
      drag = null;
    });

    ui.zoom.addEventListener('input', function () {
      pxPerSec = Number(ui.zoom.value);
      renderTimeline();
    });

    ui.loop.addEventListener('change', function () {
      ui.loop.blur();
    });

    // Toolbar buttons
    tl.querySelector('#tl-bar').addEventListener('click', function (e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      btn.blur();
      switch (btn.dataset.act) {
        case 'record': toggleRecord(); break;
        case 'play': togglePlay(); break;
        case 'home': playing = false; setTime(0); updateButtons(); break;
        case 'addkey': addKeyAtTime(); break;
        case 'delkey': deleteSelected(); break;
        case 'save': saveJson(); break;
        case 'load': ui.file.click(); break;
        case 'export': exportLua(); break;
        case 'hide': tl.classList.add('hidden'); break;
        default: break;
      }
      updateButtons();
    });

    ui.file.addEventListener('change', function () {
      const file = ui.file.files[0];
      ui.file.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () { loadProjectText(String(reader.result)); };
      reader.readAsText(file);
    });

    // Property editor for the selected keyframe
    ui.pr.t.addEventListener('change', function () {
      if (!selected) return;
      const v = Number(ui.pr.t.value);
      if (!isNum(v)) return;
      selected.t = Math.max(0, v);
      sortKeys();
      renderTimeline();
      setTime(selected.t);
    });
    ui.pr.style.addEventListener('change', function () {
      if (selected) selected.style = ui.pr.style.value;
    });
    ui.pr.dir.addEventListener('change', function () {
      if (selected) selected.dir = ui.pr.dir.value;
    });
    CHANNELS.forEach(function (ch) {
      ui.pr[ch].addEventListener('change', function () {
        if (!selected) return;
        const v = Number(ui.pr[ch].value);
        if (!isNum(v)) return;
        selected[ch] = ch === 'fov' ? clamp(v, CONFIG.fovMin, CONFIG.fovMax) : v;
        renderProps();
        setTime(selected.t);
      });
    });

    // Mouse look (only used when no phone is connected)
    let dragLook = null;
    renderer.domElement.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || playing || recording || phoneLive) return;
      dragLook = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointermove', function (e) {
      if (!dragLook) return;
      const dx = e.clientX - dragLook.x;
      const dy = e.clientY - dragLook.y;
      dragLook.x = e.clientX;
      dragLook.y = e.clientY;
      lookEuler.yaw -= dx * CONFIG.mouseLookSpeed;
      lookEuler.pitch = clamp(lookEuler.pitch - dy * CONFIG.mouseLookSpeed, -89, 89);
    });
    window.addEventListener('pointerup', function () {
      dragLook = null;
    });

    // ---- phone connection (PeerJS cloud signalling + WebRTC) ----
    const code = makeCode();
    let peerStatus = 'starting';
    let phoneStatus = 'waiting for phone';
    let phoneConn = null;

    function renderHud() {
      const mode = recording ? 'RECORDING' : playing ? 'PLAYING' : 'LIVE';
      hud.textContent =
        'Code: ' + code + '  (enter this on the phone)\n' +
        'Server: ' + peerStatus + '\n' +
        'Phone: ' + phoneStatus + '\n' +
        'Mode: ' + mode + '   Time: ' + fmtTime(time) + '\n' +
        'Pos: ' + player.x.toFixed(1) + ', ' + (player.feetY + eye).toFixed(1) + ', ' + player.z.toFixed(1) + '\n' +
        'FOV: ' + fovDeg + '  (+ / - to change)\n' +
        'Sensitivity: ' + sensitivity.toFixed(2) + 'x\n' +
        'WASD move  Space jump  C crouch  R reset\n' +
        'T timeline  P play  B record  K key  H hide HUD';
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
        phoneLive = true;
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
          phoneLive = false;
          syncLookFromCamera();
          phoneStatus = 'disconnected (mouse look enabled)';
        }
      });
    });

    // ---- keyboard ----
    function isTypingTarget(el) {
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
    }

    function setFov(value) {
      fovDeg = clamp(value, CONFIG.fovMin, CONFIG.fovMax);
      camera.fov = fovDeg;
      camera.updateProjectionMatrix();
    }

    window.addEventListener('keydown', function (e) {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      held[e.code] = true;
      if (e.code === 'Space' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
      }
      if (e.code === 'ArrowLeft') stepTime(-1);
      else if (e.code === 'ArrowRight') stepTime(1);
      if (e.repeat) return;

      if (e.key === '+' || e.key === '=') setFov(fovDeg + 1);
      else if (e.key === '-' || e.key === '_') setFov(fovDeg - 1);

      switch (e.code) {
        case 'KeyR': resetPosition(); break;
        case 'KeyH': hud.style.display = hud.style.display === 'none' ? '' : 'none'; break;
        case 'KeyT': tl.classList.toggle('hidden'); break;
        case 'KeyP': togglePlay(); break;
        case 'KeyB': toggleRecord(); break;
        case 'KeyK': addKeyAtTime(); break;
        case 'KeyL': ui.loop.checked = !ui.loop.checked; break;
        case 'Home': playing = false; setTime(0); break;
        case 'Delete':
        case 'Backspace': deleteSelected(); break;
        default: break;
      }
      updateButtons();
    });

    window.addEventListener('keyup', function (e) {
      held[e.code] = false;
    });

    // Release all keys when the window loses focus, so nothing gets stuck.
    window.addEventListener('blur', function () {
      for (const k in held) {
        held[k] = false;
      }
    });

    window.addEventListener('resize', function () {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    });

    // ---- main loop ----
    function frame(now) {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      if (recording) {
        time += dt;
        recordSample();
        updateLive(dt);
        updatePlayhead();
        updateTimeLabel();
      } else if (playing) {
        time += dt;
        const end = duration();
        if (time >= end) {
          if (ui.loop.checked && end > 0) {
            time = time % end;
          } else {
            time = end;
            playing = false;
            updateButtons();
            setStatus('Finished.');
          }
        }
        applyPoseAt(time);
        updatePlayhead();
        updateTimeLabel();
      } else {
        updateLive(dt);
      }

      if (timelineDirty && now - lastTimelineRender > 250) {
        renderTimeline();
      }
      renderHud();
      requestAnimationFrame(frame);
    }

    renderTimeline();
    updateButtons();
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

  // Exposed for automated tests only (not used in the browser)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      CHANNELS: CHANNELS,
      EASING_STYLES: EASING_STYLES,
      EASING_DIRS: EASING_DIRS,
      wrapDelta: wrapDelta,
      unwrapPose: unwrapPose,
      applyEasing: applyEasing,
      normalizeKey: normalizeKey,
      evaluateTimeline: evaluateTimeline,
      bakeTimeline: bakeTimeline,
      buildLuau: buildLuau
    };
  }

  if (typeof document !== 'undefined') {
    main();
  }
})();
