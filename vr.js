// =============================================================
// VR / WebXR Hilfsfunktionen
// - Start-VR Button (enterVR)
// - Optional: Pointer-Lock für Desktop (wenn look-controls es erlaubt)
// - Optional: Komfort/Experiment-Komponente "return-to-start"
// =============================================================

// -------------------------------------------------------------
// Initialisierung (DOM ready)
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const scene = document.querySelector('a-scene');
  if (!scene) return;

  // Patch: Layers hart deaktivieren, bevor Three.js XR-Session startet.
  patchWebXRManager();
    patchXRSessionRenderState();

  // Workaround: Einige Runtimes melden WebXR-Layers, liefern aber keinen Shared Buffer.
  // Drei.js nutzt dann XRWebGLBinding.getViewSubImage -> InvalidStateError.
  // Daher Layers explizit deaktivieren (Fallback auf XRWebGLLayer).
  disableWebXrLayers(scene);
  scene.addEventListener('rendererinitialized', () => {
    patchWebXRManager();
    patchXRSessionRenderState();
    disableWebXrLayers(scene);
  }, { once: true });
  scene.addEventListener('renderstart', () => disableWebXrLayers(scene), { once: true });
  scene.addEventListener('enter-vr', () => disableWebXrLayers(scene));

  const vrBtn = document.getElementById('start-vr');
  if (vrBtn) {
    vrBtn.addEventListener('click', () => {
      enterVr(scene); // startet WebXR-Session (wenn verfügbar)

      // Fallback: Starthinweis direkt beim Klick anstoßen (enter-vr Event kommt je nach Browser verzögert).
      try {
        if (window.adhs && typeof window.adhs.showVrStartHint === 'function') {
          setTimeout(() => window.adhs.showVrStartHint({ autoHideMs: 6500 }), 250);
        }
      } catch (e) {}

      // Desktop-Mouselook: PointerLock sofort im Click-Handler anfordern.
      // Dadurch verschwindet der Mauszeiger und Umschauen klappt „überall“.
      if (hasPointerLock()) requestPointerLockSoon(scene); // Desktop: Maus „capturen“ für Mouselook
    });
  }

  if (hasPointerLock()) enablePointerLock(scene);

  ensureRigFloorAlignment(scene);
  installSpectatorMirror(scene);

  // Sauberer Rückweg: wenn VR endet, PointerLock lösen.
  scene.addEventListener('exit-vr', () => {
    try {
      if (document.exitPointerLock) document.exitPointerLock();
    } catch (e) {
      // ignorieren
    }
  });
});
function patchXRSessionRenderState() {
  try {
    if (window.__desyncXRSessionPatchApplied) return;
    window.__desyncXRSessionPatchApplied = true;
  } catch (e) {
    // continue
  }

  try {
    const XRSessionRef = (typeof XRSession !== 'undefined') ? XRSession : null;
    if (!XRSessionRef || !XRSessionRef.prototype) return;
    if (XRSessionRef.prototype.__desyncPatchedUpdateRenderState) return;

    const original = XRSessionRef.prototype.updateRenderState;
    if (typeof original !== 'function') return;

    XRSessionRef.prototype.updateRenderState = function patchedUpdateRenderState(state) {
      try {
        if (state && state.layers) {
          const safe = Object.assign({}, state);
          delete safe.layers;
          return original.call(this, safe);
        }
      } catch (e) {
        // fall through to original
      }
      return original.call(this, state);
    };

    XRSessionRef.prototype.__desyncPatchedUpdateRenderState = true;
  } catch (e) {
    // ignorieren
  }
}

function disableWebXrLayers(scene) {
  try {
    const renderer = scene && scene.renderer;
    const xr = renderer && renderer.xr;
    if (!xr) return;

    if ('useXRSessionLayers' in xr) xr.useXRSessionLayers = false;
    if ('_useXRSessionLayers' in xr) xr._useXRSessionLayers = false;

    // Erzwinge "false" auch bei späteren Zuweisungen
    try {
      Object.defineProperty(xr, 'useXRSessionLayers', { configurable: true, get: () => false, set: () => false });
    } catch (e) {}
    try {
      Object.defineProperty(xr, '_useXRSessionLayers', { configurable: true, get: () => false, set: () => false });
    } catch (e) {}
  } catch (e) {
    // ignorieren
  }
}

function patchWebXRManager() {
  try {
    if (window.__desyncWebXRPatchApplied) return;
    window.__desyncWebXRPatchApplied = true;
  } catch (e) {
    // continue
  }

  try {
    if (typeof THREE === 'undefined' || !THREE.WebXRManager || !THREE.WebXRManager.prototype) return;
    const proto = THREE.WebXRManager.prototype;
    if (proto.__desyncPatchedSetSession) return;

    const original = proto.setSession;
    if (typeof original !== 'function') return;

    proto.setSession = function patchedSetSession(session) {
      try {
        if ('useXRSessionLayers' in this) this.useXRSessionLayers = false;
        if ('_useXRSessionLayers' in this) this._useXRSessionLayers = false;
      } catch (e) {}
      return original.call(this, session);
    };

    proto.__desyncPatchedSetSession = true;
  } catch (e) {
    // ignorieren
  }
}

function showVrError(message, err) {
  try {
    window.__lastVrError = err || new Error(String(message || 'VR error'));
  } catch (e) {}

  const host = document.getElementById('ui-overlay') || document.body;
  if (!host) {
    try { alert(String(message || 'VR-Start fehlgeschlagen.')); } catch (e) {}
    return;
  }

  try {
    let box = document.getElementById('vr-start-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'vr-start-error';
      box.style.cssText =
        'position:fixed; left:12px; right:12px; bottom:12px; z-index:999999; padding:12px 14px; border-radius:12px; background:rgba(239,68,68,.92); color:#fff; font:14px/1.35 system-ui,Segoe UI,Roboto,sans-serif; box-shadow:0 10px 25px rgba(0,0,0,.25)';
      host.appendChild(box);
    }

    const details = err && (err.message || String(err)) ? `\n${err.message || String(err)}` : '';
    box.textContent = `${String(message || 'VR-Start fehlgeschlagen.')}${details}`;
  } catch (e) {
    try { alert(String(message || 'VR-Start fehlgeschlagen.')); } catch (e2) {}
  }
}

async function preflightWebXR() {
  // WebXR braucht Secure Context: https:// oder localhost.
  try {
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const secure = location.protocol === 'https:' || isLocalhost;
    if (!secure) {
      return {
        ok: false,
        reason:
          'WebXR blockiert auf http. Öffne die Seite über https:// oder nutze Air Link + PC-Browser (localhost).'
      };
    }
  } catch (e) {}

  if (!('xr' in navigator)) {
    return { ok: false, reason: 'WebXR (navigator.xr) ist in diesem Browser nicht verfügbar.' };
  }

  try {
    if (navigator.xr && navigator.xr.isSessionSupported) {
      const ok = await navigator.xr.isSessionSupported('immersive-vr');
      if (!ok) return { ok: false, reason: 'Immersive VR wird hier nicht unterstützt.' };
    }
  } catch (e) {
    // Manche Browser werfen hier; wir versuchen trotzdem den Start.
  }

  return { ok: true };
}

function requestPointerLockSoon(scene) {
  const tryLock = () => {
    if (!scene?.canvas) return false;
    if (document.pointerLockElement === scene.canvas) return true;
    if (!scene.canvas.requestPointerLock) return false;
    try {
      // PointerLock braucht meist einen User-Click (wir sind hier im Click-Handler / kurz danach).
      scene.canvas.requestPointerLock();
      return true;
    } catch (e) {
      return false;
    }
  };

  // Canvas existiert erst nach renderstart.
  if (scene?.hasLoaded && scene.canvas) {
    tryLock();
    return;
  }

  scene?.addEventListener?.('renderstart', () => {
    tryLock();
    setTimeout(tryLock, 50);
    setTimeout(tryLock, 250);
  }, { once: true });
}

// -------------------------------------------------------------
// Optionales Komfort-/Experiment-Feature:
// Rig bleibt auf Startposition und hält die Blickrichtung stabil,
// indem die Kopf-Yaw durch Gegenrotation des Rigs kompensiert wird.
// Hinweis: Das kann sich in VR unnatürlich anfühlen.
// -------------------------------------------------------------
if (typeof AFRAME !== 'undefined' && AFRAME?.registerComponent) {
  AFRAME.registerComponent('return-to-start', {
    schema: {
      enabled: { default: true },
      lockPosition: { default: true },
      lockWorldYaw: { default: true },
      strength: { default: 0.35 }, // 0..1 (1 = sofort)
      deadzoneDeg: { default: 0.0 }
    },

    init() {
      this.startPos = this.el.object3D.position.clone();
      this.startRot = this.el.object3D.rotation.clone();
      this.cameraEl = this.el.querySelector('[camera]') || null;
      this._deadzoneRad = THREE.MathUtils.degToRad(this.data.deadzoneDeg);
    },

    update() {
      this._deadzoneRad = THREE.MathUtils.degToRad(this.data.deadzoneDeg);
    },

    tick() {
      if (!this.data.enabled) return;

      if (this.data.lockPosition) {
        this.el.object3D.position.copy(this.startPos);
      }

      if (!this.data.lockWorldYaw || !this.cameraEl) return;

      // cameraEl.rotation ist lokal unter dem Rig (Head pose / look-controls)
      const headYaw = wrapRad(this.cameraEl.object3D.rotation.y);
      if (Math.abs(headYaw) <= this._deadzoneRad) {
        // sanft zurück zur Start-Yaw
        this.el.object3D.rotation.y = lerpAngleRad(this.el.object3D.rotation.y, this.startRot.y, this.data.strength);
        this.el.object3D.rotation.x = this.startRot.x;
        this.el.object3D.rotation.z = this.startRot.z;
        return;
      }

      const targetYaw = wrapRad(this.startRot.y - headYaw);
      this.el.object3D.rotation.y = lerpAngleRad(this.el.object3D.rotation.y, targetYaw, this.data.strength);
      this.el.object3D.rotation.x = this.startRot.x;
      this.el.object3D.rotation.z = this.startRot.z;
    }
  });

  function wrapRad(rad) {
    let r = rad;
    while (r > Math.PI) r -= Math.PI * 2;
    while (r < -Math.PI) r += Math.PI * 2;
    return r;
  }

  function lerpAngleRad(current, target, alpha) {
    const c = wrapRad(current);
    const t = wrapRad(target);
    let delta = wrapRad(t - c);
    return wrapRad(c + delta * THREE.MathUtils.clamp(alpha, 0, 1));
  }

  // Stabilisiertes HUD: folgt der Kamera weich, nur Yaw (kein Pitch/Roll)
  AFRAME.registerComponent('hud-stabilize', {
    schema: {
      distance: { default: 1.6 },
      height: { default: 0.05 },
      followSpeed: { default: 0.08 },
      yawOnly: { default: true }
    },

    init() {
      this._targetPos = new THREE.Vector3();
      this._targetQuat = new THREE.Quaternion();
      this._forward = new THREE.Vector3();
      this._up = new THREE.Vector3(0, 1, 0);
    },

    tick() {
      const scene = this.el.sceneEl;
      const cam = scene && scene.camera;
      if (!cam) return;

      // Kamera-Position in Weltkoordinaten
      const camPos = new THREE.Vector3();
      cam.getWorldPosition(camPos);

      // Vorwärtsrichtung der Kamera
      this._forward.set(0, 0, -1).applyQuaternion(cam.quaternion);
      if (this.data.yawOnly) {
        this._forward.y = 0;
        this._forward.normalize();
      }

      // Zielposition: vor der Kamera + leicht höher
      this._targetPos.copy(camPos)
        .add(this._forward.multiplyScalar(this.data.distance))
        .add(this._up.clone().multiplyScalar(this.data.height));

      // Zielrotation: nur Yaw, damit Text ruhig bleibt
      const lookAt = new THREE.Vector3().copy(camPos);
      lookAt.y = this._targetPos.y;
      const m = new THREE.Matrix4();
      m.lookAt(this._targetPos, lookAt, this._up);
      this._targetQuat.setFromRotationMatrix(m);

      // Plane-Front in A-Frame zeigt +Z; LookAt richtet -Z auf Kamera.
      // Daher um 180° drehen, damit Text korrekt herum angezeigt wird.
      const flip = new THREE.Quaternion().setFromAxisAngle(this._up, Math.PI);
      this._targetQuat.multiply(flip);

      // Sanft folgen
      this.el.object3D.position.lerp(this._targetPos, THREE.MathUtils.clamp(this.data.followSpeed, 0.01, 0.5));
      this.el.object3D.quaternion.slerp(this._targetQuat, THREE.MathUtils.clamp(this.data.followSpeed, 0.01, 0.5));
    }
  });
}

function enterVr(scene) {
  // Startet WebXR (wenn verfügbar) – bevorzugt über die aktuelle Scene.
  // Hinweis: In Desktop ohne Headset kann das trotzdem „VR Mode“ auslösen (Magic Window).
  (async () => {
    // Debounce: verhindert Doppel-Klick / doppelte Handler
    try {
      if (window.__desyncVrStartInFlight) return;
      window.__desyncVrStartInFlight = true;
    } catch (e) {}

    const pf = await preflightWebXR();
    if (!pf.ok) {
      showVrError(pf.reason);
      try { window.__desyncVrStartInFlight = false; } catch (e) {}
      return;
    }

    try {
      const targetScene = (scene && scene.enterVR) ? scene : (AFRAME?.scenes?.[0] || null);
      if (!targetScene || !targetScene.enterVR) {
        showVrError('VR nicht verfügbar: A-Frame Scene hat keine enterVR()-Methode.');
        try { window.__desyncVrStartInFlight = false; } catch (e) {}
        return;
      }

      // WebXR-Layers deaktivieren (Quest/Air Link InvalidStateError vermeiden)
      patchWebXRManager();
        patchXRSessionRenderState();
      disableWebXrLayers(targetScene);

      // Wenn bereits eine immersive Session läuft, darf requestSession nicht nochmal aufgerufen werden.
      // In dem Fall: als Toggle behandeln und versuchen zu beenden.
      try {
        const xr = targetScene && targetScene.renderer && targetScene.renderer.xr;
        let session = null;
        try {
          session = xr && xr.getSession && xr.getSession();
        } catch (e) {
          session = null;
        }
        const inVr = !!(
          (targetScene.is && targetScene.is('vr-mode')) ||
          (xr && xr.isPresenting) ||
          session
        );
        if (inVr) {
          if (targetScene.exitVR) {
            let ep = null;
            try {
              ep = targetScene.exitVR();
            } catch (e) {
              // ignore
            }
            if (ep && typeof ep.finally === 'function') {
              ep.finally(() => {
                try { window.__desyncVrStartInFlight = false; } catch (e) {}
              });
              return;
            }
          }
          // Fallback: nichts tun, aber nicht crashen.
          tryPlayDomOverlayAmbience();
          try { window.__desyncVrStartInFlight = false; } catch (e) {}
          return;
        }
      } catch (e) {
        // ignore
      }

      const p = targetScene.enterVR();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          console.warn('VR Start failed:', err);
          // Häufig bei Doppelclick/Toggle: Session läuft schon -> nicht als harter Fehler behandeln.
          const msg = String(err && (err.name || err.message) ? (err.name + ': ' + err.message) : (err && err.message ? err.message : err));
          if (/InvalidStateError/i.test(msg) && /already an active/i.test(msg)) {
            // Session ist aktiv: einfach ignorieren.
            return;
          }
          showVrError('VR-Start fehlgeschlagen.', err);
        });
      }
      tryPlayDomOverlayAmbience(); // Audio starten, weil hier die Autoplay-Policy „entsperrt“ ist

      // in-flight lock nach kurzer Zeit lösen, auch wenn kein Promise zurückkommt
      setTimeout(() => {
        try { window.__desyncVrStartInFlight = false; } catch (e) {}
      }, 1200);
    } catch (err) {
      console.warn('VR Start failed:', err);
      showVrError('VR-Start fehlgeschlagen.', err);
      try { window.__desyncVrStartInFlight = false; } catch (e) {}
    }
  })();
}

function tryPlayDomOverlayAmbience() {
  // Manche Szenen nutzen ein leises Ambient-Track.
  // Wegen Autoplay-Policies wird Audio nur direkt durch den Start-VR Klick gestartet.
  try {
    const candidates = document.querySelectorAll('[data-play-on-vr="1"]');
    candidates.forEach((el) => {
      const cmp = el?.components?.sound;
      if (cmp?.playSound) cmp.playSound();
    });
  } catch (e) {
    // ignorieren
  }
}

function hasPointerLock() {
  // Prüft, ob look-controls PointerLock explizit erlaubt.
  const els = document.querySelectorAll('[look-controls]');
  for (const el of els) {
    const cfg = el.getAttribute('look-controls');
    if (!cfg) continue;
    // A-Frame liefert hier je nach Schreibweise entweder einen String oder ein Objekt (Komponenten-Daten).
    if (typeof cfg === 'object') {
      if (cfg.pointerLockEnabled === true) return true;
      continue;
    }
    if (typeof cfg === 'string') {
      if (/pointerLockEnabled\s*:\s*true/i.test(cfg)) return true;
      continue;
    }
  }
  return false;
}

function enablePointerLock(scene) {
  // Aktiviert PointerLock nur im Desktop-Modus (Click auf Canvas).
  const attach = () => {
    if (!scene.canvas) return;
    scene.canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== scene.canvas && scene.canvas.requestPointerLock) {
        try {
          scene.canvas.requestPointerLock();
        } catch (e) {
          // PointerLock nicht unterstützt
        }
      }
    });
  };

  if (scene.hasLoaded && scene.canvas) {
    attach();
  } else {
    scene.addEventListener('renderstart', attach, { once: true });
  }
}

function ensureRigFloorAlignment(scene) {
  if (!scene) return;

  const init = () => {
    const rig = scene.querySelector('#rig');
    if (!rig || rig.__vrFloorAligned) return;

    const desktopPos = cloneVector3Attr(rig.getAttribute('position'));
    if (!desktopPos) return;

    const setRigPosition = (pos) => {
      if (!pos) return;
      rig.setAttribute('position', {
        x: Number(pos.x) || 0,
        y: Number(pos.y) || 0,
        z: Number(pos.z) || 0
      });
    };

    const moveToVrFloor = () => {
      setRigPosition({ x: desktopPos.x, y: 0, z: desktopPos.z });
    };

    const restoreDesktopPose = () => {
      setRigPosition(desktopPos);
    };

    scene.addEventListener('enter-vr', moveToVrFloor);
    scene.addEventListener('exit-vr', restoreDesktopPose);

    rig.__vrFloorAligned = true;
  };

  if (scene.hasLoaded) {
    init();
  } else {
    scene.addEventListener('loaded', init, { once: true });
  }
}

function cloneVector3Attr(attr) {
  if (!attr) return null;
  return {
    x: typeof attr.x === 'number' ? attr.x : parseFloat(attr.x) || 0,
    y: typeof attr.y === 'number' ? attr.y : parseFloat(attr.y) || 0,
    z: typeof attr.z === 'number' ? attr.z : parseFloat(attr.z) || 0
  };
}

function installSpectatorMirror(scene) {
  if (!scene || scene.__desyncSpectatorInstalled) return;
  scene.__desyncSpectatorInstalled = true;

  const ensureElements = () => {
    const host = document.getElementById('ui-overlay') || document.body;
    if (!host) return {};

    let wrapper = document.getElementById('spectator-monitor');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'spectator-monitor';
      wrapper.innerHTML = '<video muted playsinline autoplay></video><div class="spectator-badge">Monitor</div>';
      host.appendChild(wrapper);
    }

    const video = wrapper.querySelector('video');
    if (video) {
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', 'true');
      video.setAttribute('muted', 'true');
    }

    return { wrapper, video };
  };

  let activeStream = null;

  const stopMirror = () => {
    if (activeStream) {
      try {
        activeStream.getTracks().forEach((track) => track.stop());
      } catch (e) {
        // ignore
      }
      activeStream = null;
    }

    const wrapper = document.getElementById('spectator-monitor');
    const video = wrapper ? wrapper.querySelector('video') : null;
    if (video) {
      try {
        video.pause();
      } catch (e) {}
      try {
        video.srcObject = null;
      } catch (e) {}
    }
    if (wrapper) wrapper.classList.remove('is-visible');
  };

  const startMirror = () => {
    if (!scene.canvas || !scene.canvas.captureStream) return;
    const nodes = ensureElements();
    if (!nodes.wrapper || !nodes.video) return;

    stopMirror();
    try {
      activeStream = scene.canvas.captureStream(30);
      if (!activeStream) return;
      nodes.video.srcObject = activeStream;
      nodes.wrapper.classList.add('is-visible');
      const playPromise = nodes.video.play();
      if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
    } catch (e) {
      stopMirror();
    }
  };

  const attach = () => {
    scene.addEventListener('enter-vr', startMirror);
    scene.addEventListener('exit-vr', stopMirror);
    window.addEventListener('beforeunload', stopMirror);
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') stopMirror();
    });
  };

  if (scene.hasLoaded) {
    attach();
  } else {
    scene.addEventListener('loaded', attach, { once: true });
  }
}
