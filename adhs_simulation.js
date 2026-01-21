// ADHS Simulation
// =============================================================
// Überblick (wo ist was?)
// - Klasse ADHSSimulation: Hauptlogik pro Szene/Umgebung
// - State/Parameter: Aufgaben, Stress, Zeitblindheit, Intensität
// - Ablenkungen: visuell (Gedankenblase etc.) + audio (Geräusche)
// - UI: DOM-Overlay (Browser) + VR-HUD (Fallback im Headset)
// - Input: Tastatur (Q/W/E/G/R + Shift+V) + ESP32 Buttons
// - Globaler Bootstrap: erstellt window.adhs und initialisiert
// =============================================================

// =============================================================
// Schnellnavigation (wichtige Einstiegsstellen)
// - start(level) / stop(): Lifecycle (Simulation an/aus)
// - tickTaskLoop(): Task-Logik (Prokrastination/Working/Hyperfokus)
// - spawnVisualDistraction() / playAudioDistraction() / createLargePopup(): Ablenkungen
// - handleUserGaveIn() / handleUserRefocus(): Input → sicht-/messbares Feedback
// - installVrHudOnce() / createVrHud() / updateVrHud(): Overlay vs. VR-HUD
// - startSupermarketAmbience(): Supermarkt-Ambiente (durchgehender Loop)
// =============================================================


export class ADHSSimulation {

    constructor() {
        // Basis-Zustand (Environment kommt aus der Scene-URL)
        this.environment = this.detectEnvironment(); // 'desk' | 'hoersaal' | 'supermarkt'
        this.active = false; // Simulation läuft (Effekte/Tasks aktiv)
        this.paused = false; // „Stop“ gedrückt / pausiert
        this.distractionLevel = 0; // 0..3 (Aus/Leicht/Mittel/Stark)

        // Timers/Intervals (werden in start() gesetzt und in stop() aufgeräumt)
        this.visualInterval = null; // visuelle Ablenkungen spawnen
        this.audioInterval = null; // Sound-Ablenkungen abspielen
        this.notificationInterval = null; // Handy/Notifications
        this._taskTickInterval = null; // Task-Loop (tickTaskLoop)

        // Collections (damit wir alles sauber entfernen können)
        this.visualDistractions = []; // aktive A-Frame Entities (Popups, Blasen, etc.)
        this.taskPanel = null; // DOM Panel im Overlay

        // Tasks / Status (leicht „spielifiziert“, damit Effekte sichtbar werden)
        this.tasks = this._buildDefaultTasks(this.environment); // Default-Tasks je Umgebung
        this.taskList = (this.tasks || []).map(t => t.text); // nur Texte (Legacy/UI)
        this.activeTaskIndex = 0; // welche Task gerade „aktiv“ ist
        this.taskState = 'idle'; // 'idle' | 'procrastinating' | 'working' | 'hyperfocus'
        this.taskStateUntil = 0; // Timestamp: wann ein State automatisch endet

        // Psychologie/Meta (vereinfachtes Modell)
        this.stress = 0; // 0..1, beeinflusst z.B. Pile-Up
        this._totalTimeWasted = 0; // Sekunden (für Summary)
        this._giveInCount = 0;
        this._giveInSpiralMultiplier = 1.0;
        this._refocusStreak = 0;
        this._refocusBoost = 0;
        this._refocusBoostUntil = 0;
        this._refocusShieldUntil = 0;
        this._refocusHardLockUntil = 0;
        this._hyperfocusUntil = 0;
        this._reentryUntil = 0;
        this._timeBlindnessUntil = 0;
        this._timeBlindnessMsg = '';
        this._actionMsg = '';
        this._actionMsgUntil = 0;

        // Blick/Fokus Heuristik ("wegschauen" -> Stress/Feedback)
        this._lookAwayMs = 0;
        this._lookAwayLastAt = 0;
        this._lastLookAwayMsgAt = 0;
        this._isLookingAway = false;
        this._focusAngleEma = null;
        this._lookAwayPenaltyActive = false;

        // Smartphone Popup Rate-Limit (damit es nicht „unfair“ spammt)
        this._lastPhonePopupAt = 0;
        this._phonePopupMinMs = 10000;

        // Anti-repeat (Notifications): avoid repeating the same text too quickly
        this._recentMonitorNotifAt = new Map();
        this._recentPhoneNotifAt = new Map();
        this._phoneNotifRepeatMinMs = 30000;
        this._monitorNotifRepeatMinMs = 12000;

        // Throttle how often phone notifications can inject new tasks
        this._lastPhoneTodoAt = 0;
        this._phoneTodoMinMs = 28000;

        // Habituation (Wiederholung soll weniger „Impact“ haben)
        this._habituation = new Map();

        // Audio
        this._audioCtx = null;
        this.professorAudioContext = null;
        this.professorGain = null;
        this._audioBufferCache = new Map();
        // Globaler Lautstärke-Boost (clamped in output). Werte > 1.0 machen es lauter.
        // (Nur leicht erhoeht, damit nichts clippt.)
        this._volumeBoost = 1.15;

        // Default Config pro Level
        // Frequenzen sind Intervalle (ms): kleiner = häufiger.
        this.config = {
            none: { visualFrequency: 999999, audioFrequency: 999999, notificationFrequency: 999999, movementSpeed: 0 },
            low: { visualFrequency: 5200, audioFrequency: 6400, notificationFrequency: 16000, movementSpeed: 0.35 },
            medium: { visualFrequency: 3800, audioFrequency: 4600, notificationFrequency: 12500, movementSpeed: 0.55 },
            high: { visualFrequency: 2600, audioFrequency: 3400, notificationFrequency: 10000, movementSpeed: 0.8 }
        };

        // UI einmal initial synchronisieren
        try { this.updateStatusDisplay(); } catch (e) {}

        // Optional Debug: ?debugNotif=1 zeigt Zähler im Overlay
        try {
            this._debugNotif = /[?&]debugNotif=1(\b|&|$)/.test(String(window.location && window.location.search || ''));
        } catch (e) {
            this._debugNotif = false;
        }

        // VR-HUD früh initialisieren, damit das Interface im Headset sofort mitwandert.
        try { this.installVrHudOnce(); } catch (e) {}
    }

    _ensureDebugNotifBadge() {
        if (!this._debugNotif) return null;
        let el = document.getElementById('adhs-debug-notif');
        if (el) return el;
        const root = document.getElementById('ui-overlay') || document.body;
        if (!root) return null;
        el = document.createElement('div');
        el.id = 'adhs-debug-notif';
        el.style.position = 'fixed';
        el.style.top = '8px';
        el.style.right = '8px';
        el.style.zIndex = '99999';
        el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
        el.style.fontSize = '12px';
        el.style.padding = '6px 8px';
        el.style.borderRadius = '10px';
        el.style.background = 'rgba(15, 23, 42, 0.85)';
        el.style.color = '#e2e8f0';
        el.style.pointerEvents = 'none';
        el.textContent = 'notif: 0 / popup: 0';
        root.appendChild(el);
        return el;
    }

    _buildDefaultTasks(env) {
        const byEnv = {
            desk: [
                { text: 'Hausarbeit weiterschreiben', kind: 'deepwork', progress: 0, completed: false },
                { text: 'Mails beantworten', kind: 'email', progress: 0, completed: false },
                { text: 'Abgabe planen', kind: 'planning', progress: 0, completed: false }
            ],
            hoersaal: [
                { text: 'Mitschreiben: Kernaussagen', kind: 'study', progress: 0, completed: false },
                { text: 'Folie verstehen', kind: 'study', progress: 0, completed: false },
                { text: 'Frage formulieren', kind: 'planning', progress: 0, completed: false }
            ],
            supermarkt: [
                { text: 'Einkaufsliste abarbeiten', kind: 'errand', progress: 0, completed: false },
                { text: 'Nichts vergessen', kind: 'planning', progress: 0, completed: false },
                { text: 'Kasse finden', kind: 'errand', progress: 0, completed: false }
            ]
        };
        return (byEnv[env] || byEnv.desk).map(t => ({ ...t }));
    }

                /**
                 * Gedankenblase als visuelle Ablenkung
                 */
                createThoughtBubble() {
                    const scene = document.querySelector('a-scene');
                    const camera = document.querySelector('a-camera') || document.querySelector('[camera]');
                    if (!scene || !camera) return;
                    // Typische Gedanken für jede Umgebung
                    const thoughtsByEnv = {
                        desk: [
                            'Was gibt’s zu essen?',
                            'Hab ich was vergessen?',
                            'Wie spät ist es?',
                            'Nachrichten checken...',
                            'Was läuft auf YouTube?',
                            'Schon wieder eine Mail?',
                            'Nur kurz ans Handy…',
                            'Ich sollte eigentlich anfangen…',
                            'Wo ist mein Notizzettel?',
                            'Warum ist das so schwer gerade?',
                            'Ich mach erst mal Kaffee…',
                            'Habe ich den Tab schon offen gehabt?',
                            'Kurz Musik anmachen?',
                            'Welche Datei war das nochmal?',
                            'Ich brauch eine Pause. Oder?',
                            'Vielleicht erstmal aufräumen…'
                        ],
                        hoersaal: [
                            'Was hat der Prof gerade gesagt?',
                            'Ich muss noch einkaufen...',
                            'Wann ist Pause?',
                            'Handy vibriert?',
                            'Was macht die Lerngruppe?',
                            'Hoffentlich fragt er mich nicht!',
                            'Hab ich die Folie fotografiert?',
                            'Ich hab den Faden verloren…',
                            'Was war die Definition?',
                            'Alle schauen so konzentriert…',
                            'Ich sitz unbequem.',
                            'Bitte keine Gruppenarbeit…',
                            'Wie lange geht das noch?',
                            'Warum bin ich so müde?',
                            'Soll ich kurz rausgehen?'
                        ],
                        supermarkt: [
                            'Was fehlt noch?',
                            'Wo ist das Sonderangebot?',
                            'Habe ich genug Geld dabei?',
                            'Was wollte ich noch kaufen?',
                            'Gibt’s Rabatt?',
                            'Schon wieder WhatsApp...',
                            'Milch… oder war’s Hafermilch?',
                            'Welche Kasse ist die schnellste?',
                            'Ich hab Hunger…',
                            'Warum ist es hier so laut?',
                            'Hab ich meinen Geldbeutel?',
                            'Oh, das sieht lecker aus.',
                            'Wo ist nochmal die Pasta?',
                            'Ich brauch eine Liste…',
                            'Nicht zu viel kaufen…'
                        ]
                    };
                    const thoughts = thoughtsByEnv[this.environment] || thoughtsByEnv.desk;
                    const text = this.randomChoice(thoughts);
                    // Blase als a-entity vor der Kamera
                    const bubble = document.createElement('a-entity');

                    // Anti-Overlap: Sprechblasen bekommen feste Slots um die Kamera
                    // (so liegen sie nicht exakt übereinander, wenn mehrere gleichzeitig spawnen)
                    const slots = [
                        // Weiter weg + mehr Abstand (verhindert, dass man durch transparente Blasen andere Texte „durchliest“)
                        { x: -0.48, y: 0.28, z: -1.10 },
                        { x:  0.48, y: 0.28, z: -1.10 },
                        { x: -0.32, y: 0.06, z: -1.04 },
                        { x:  0.32, y: 0.06, z: -1.04 },
                        { x:  0.00, y: 0.44, z: -1.18 }
                    ];

                    // Wenn bereits zu viele Thought-Bubbles aktiv sind: nicht noch eine stapeln.
                    const active = (this.visualDistractions || []).filter((d) => d && d.__adhsThoughtBubble).length;
                    if (active >= slots.length) return;

                    const used = new Set();
                    try {
                        (this.visualDistractions || []).forEach((d) => {
                            if (d && d.__adhsThoughtBubble && typeof d.__adhsThoughtSlot === 'number') used.add(d.__adhsThoughtSlot);
                        });
                    } catch (e) {}

                    let slotIndex = 0;
                    for (let i = 0; i < slots.length; i++) {
                        if (!used.has(i)) { slotIndex = i; break; }
                    }

                    const slot = slots[slotIndex] || { x: 0, y: 0.18, z: -0.7 };
                    const jx = (Math.random() - 0.5) * 0.035;
                    const jy = (Math.random() - 0.5) * 0.028;
                    const jz = (Math.random() - 0.5) * 0.025;
                    bubble.setAttribute('position', `${slot.x + jx} ${slot.y + jy} ${slot.z + jz}`);
                    bubble.__adhsThoughtBubble = true;
                    bubble.__adhsThoughtSlot = slotIndex;
                    // Hintergrund der Sprechblase
                    // NOTE: Eine flache Plane ist hier robuster als eine "Ellipse"-Sphere,
                    // weil Troika-Text sonst optisch schnell "ueber den Rand" wirkt.
                    const bubbleW = 0.52;
                    const bubbleH = 0.26;
                    const bg = document.createElement('a-plane');
                    bg.setAttribute('width', bubbleW.toFixed(3));
                    bg.setAttribute('height', bubbleH.toFixed(3));
                    bg.setAttribute('position', '0 0 0');
                    // Immer vor der Szene rendern (nicht durch Regale/Objekte verdeckt)
                    bg.setAttribute('material', 'shader: flat; color: #f1f5f9; transparent: false; depthTest: false; depthWrite: false');
                    bubble.appendChild(bg);

                    // Text: niemals ausserhalb der Blase (wrap + maxLines + shrink-to-fit)
                    const clampBubbleText = (value, maxLines, maxCharsPerLine) => {
                        const raw = String(value || '').replace(/\r\n/g, '\n').trim();
                        if (!raw) return '';

                        const words = raw.split(/\s+/).filter(Boolean);
                        const lines = [];
                        let cur = '';

                        const pushLine = (s) => {
                            const line = String(s || '').trimEnd();
                            if (!line) {
                                lines.push('');
                                return;
                            }
                            if (line.length <= maxCharsPerLine) {
                                lines.push(line);
                            } else {
                                // Hard wrap long tokens
                                let rest = line;
                                while (rest.length && lines.length < maxLines) {
                                    lines.push(rest.slice(0, maxCharsPerLine));
                                    rest = rest.slice(maxCharsPerLine);
                                }
                            }
                        };

                        for (const w of words) {
                            const next = cur ? `${cur} ${w}` : w;
                            if (next.length <= maxCharsPerLine) {
                                cur = next;
                            } else {
                                pushLine(cur);
                                cur = w;
                                if (lines.length >= maxLines) break;
                            }
                        }
                        if (lines.length < maxLines && cur) pushLine(cur);

                        let out = lines.slice(0, maxLines);
                        const wasTruncated = (lines.length > maxLines) || (words.join(' ').length > out.join(' ').length + 1);
                        if (wasTruncated && out.length) {
                            const last = out[out.length - 1];
                            const trimmed = (last.length >= maxCharsPerLine) ? last.slice(0, Math.max(0, maxCharsPerLine - 1)) : last;
                            out[out.length - 1] = trimmed.trimEnd() + '…';
                        }
                        return out.join('\n');
                    };

                    const wrapped = clampBubbleText(text, 3, 22);
                    const wrappedLen = wrapped.replace(/\n/g, ' ').length;
                    const fontSize = (wrappedLen >= 50) ? 0.020 : (wrappedLen >= 36) ? 0.023 : (wrappedLen >= 28) ? 0.026 : 0.029;

                    const bubbleText = document.createElement('a-troika-text');
                    bubbleText.setAttribute('value', wrapped);
                    // Centered in the plane -> wirkt sofort "in der Blase".
                    bubbleText.setAttribute('position', '0 0 0.006');
                    // Padding: etwas kleiner als Bubble-Plane.
                    bubbleText.setAttribute('max-width', (bubbleW - 0.10).toFixed(3));
                    bubbleText.setAttribute('font-size', fontSize.toFixed(3));
                    bubbleText.setAttribute('line-height', '1.12');
                    bubbleText.setAttribute('align', 'center');
                    bubbleText.setAttribute('anchor', 'center');
                    bubbleText.setAttribute('color', '#334155');
                    bubbleText.setAttribute('baseline', 'center');
                    bubble.appendChild(bubbleText);
                    // "Gedankenpunkte" (kleine Kreise)
                    for (let i = 1; i <= 3; i++) {
                        const dot = document.createElement('a-sphere');
                        dot.setAttribute('radius', `${0.03 - i*0.006}`);
                        dot.setAttribute('position', `0 ${-(bubbleH / 2) - 0.02 - i*0.045} ${-0.10 + i*0.05}`);
                        dot.setAttribute('color', '#f1f5f9');
                        dot.setAttribute('opacity', '1.0');
                        dot.setAttribute('material', 'shader: flat; transparent: false; depthTest: false; depthWrite: false');
                        bubble.appendChild(dot);
                    }
                    camera.appendChild(bubble);
                    this.visualDistractions.push(bubble);

                    // Troika-Text erstellt sein Mesh async -> renderOrder/depth settings mehrfach anwenden.
                    const applyOrdering = () => {
                        try {
                            if (!bubble || !bubble.object3D) return;
                            bubble.object3D.traverse((o) => {
                                o.renderOrder = 1300;
                                if (o.material) {
                                    o.material.depthTest = false;
                                    o.material.depthWrite = false;
                                }
                            });
                        } catch (e) {}
                    };
                    setTimeout(applyOrdering, 0);
                    setTimeout(applyOrdering, 120);
                    setTimeout(applyOrdering, 450);

                    // Interaktion: Wenn man die Gedankenblase anklickt, "geht man dem Gedanken nach"
                    // -> Prokrastination/Stress steigen durch User-Aktion (nicht nur random).
                    if (typeof this.makeEntityClickable === 'function') {
                        this.makeEntityClickable(bubble, { type: 'thoughtBubble', label: 'Gedanken nachgehen', severity: 0.8 });
                    }

                    // Fokus-Shift: Kamera bleibt, aber Bubble ist prominent
                    // Blase je nach Intensität etwas länger (bei starkem Level bleibt der Gedanke „kleben“)
                    const level = this.distractionLevel || 0;
                    const baseLifeByLevel = [0, 2300, 2800, 3300];
                    const jitterByLevel = [0, 550, 650, 750];
                    const life = (baseLifeByLevel[level] || 2600) + Math.random() * (jitterByLevel[level] || 600);
                    setTimeout(() => {
                        try {
                            if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
                        } catch (e) {}
                        try {
                            delete bubble.__adhsThoughtBubble;
                            delete bubble.__adhsThoughtSlot;
                        } catch (e) {}
                        const idx = this.visualDistractions.indexOf(bubble);
                        if (idx > -1) this.visualDistractions.splice(idx, 1);
                    }, life);
                }

    showTaskPanel() {
        // HTML-Overlay wie Steuerung
        let todoDiv = document.getElementById('todo-ui');
        if (!todoDiv) {
            todoDiv = document.createElement('div');
            todoDiv.id = 'todo-ui';
            todoDiv.classList.add('hud-card', 'hud-todo');
            todoDiv.style.position = 'fixed';
            todoDiv.style.bottom = '24px';
            todoDiv.style.left = '24px';
            todoDiv.style.zIndex = '9999';
            // In WebXR (dom-overlay) soll das Panel nutzbar sein (Tasks anklicken).
            todoDiv.style.pointerEvents = 'auto';
            const overlayRoot = document.getElementById('ui-overlay') || document.body;
            overlayRoot.appendChild(todoDiv);
        }

        const now = Date.now();
        // Intensität (für VR/Overlay – sonst sieht man den Zustand nicht)
        let lvlLabel = 'Aus';
        let lvlClass = 'lvl-off';
        try {
            const names = ['Aus', 'Leicht', 'Mittel', 'Stark'];
            if (!this.active || this.paused || !(this.distractionLevel > 0)) {
                lvlLabel = names[0];
                lvlClass = 'lvl-off';
            } else {
                const lvl = Math.max(0, Math.min(3, Number(this.distractionLevel || 0)));
                lvlLabel = names[lvl] || names[0];
                lvlClass = `lvl-${lvl}`;
            }
        } catch (e) {}

        let html = `
            <div class="hud-title">DeSync – To‑Dos</div>
            <div class="hud-toprow">
                <div class="hud-chip hud-chip-level ${lvlClass}">Intensität <strong>${lvlLabel}</strong></div>
            </div>
        `;

        // Zusatzinfo (spürbar + psychologisch): Fokuszustand, Stress, Zeitblindheit
        try {
            const stateLabel = {
                idle: 'Warten',
                procrastinating: 'Prokrastination',
                working: 'Arbeit',
                hyperfocus: 'Hyperfokus'
            };
            const s = this.isHyperfocusActive() ? 'hyperfocus' : (this.taskState || 'idle');
            const isReentry = (s === 'working' && this.isReentryActive && this.isReentryActive());
            const focusLabel = isReentry ? 'Re-Entry' : (stateLabel[s] || '—');
            const stressPct = Math.round((this.stress || 0) * 100);
            const tb = (now < (this._timeBlindnessUntil || 0) && this._timeBlindnessMsg) ? ` · ${this._timeBlindnessMsg}` : '';
            const am = (now < (this._actionMsgUntil || 0) && this._actionMsg) ? ` · ${this._actionMsg}` : '';
            html += `<div class="hud-subtitle">Fokus: ${focusLabel} · Stress: ${stressPct}%${tb}${am}</div>`;
        } catch (e) {}

        // Statuswerte (sauber als eigene Zeile/"Chips")
        try {
            const stressPct = Math.round((this.stress || 0) * 100);
            const streak = Math.max(0, (this._refocusStreak || 0));
            const wastedMin = Math.max(0, Math.round(((this._totalTimeWasted || 0) / 60)));
            const spiral = Math.max(1, (this._giveInSpiralMultiplier || 1));
            const spiralTxt = spiral.toFixed(1);
            const shieldLeft = Math.max(0, Math.round(Math.max(0, (this._refocusShieldUntil || 0) - now) / 1000));
            const shieldChip = shieldLeft > 0 ? `<div class="hud-chip hud-chip-focus">Shield <strong>${shieldLeft}s</strong></div>` : '';

            html += `
                <div class="hud-metrics">
                    <div class="hud-chip">Stress <strong>${stressPct}%</strong></div>
                    <div class="hud-chip hud-chip-streak">Streak <strong>${streak}x</strong></div>
                    <div class="hud-chip">Zeit weg <strong>${wastedMin}m</strong></div>
                    <div class="hud-chip hud-chip-spiral">Spirale <strong>${spiralTxt}×</strong></div>
                    ${shieldChip}
                </div>
            `;
        } catch (e) {}

        const fullList = (this.tasks && this.tasks.length) ? this.tasks : (this.taskList || []).map(t => ({ text: t, kind: 'misc', progress: 0 }));
        const list = (this.isFocusModeActive && this.isFocusModeActive())
            ? [fullList[Math.max(0, Math.min(this.activeTaskIndex || 0, fullList.length - 1))]].filter(Boolean)
            : fullList;

        list.forEach((task, i) => {
            const text = task.text || String(task);
            const isUrgent = /abgabe|hausarbeit|seminar|vortrag|feedback|meeting|präsentation|aufgabe|lernen|übung/i.test(text);
            const isWarn = /einkauf|milch|pizza|arzt|rechnung|kontostand/i.test(text);
            const icon = isUrgent ? '📚' : (isWarn ? '🛒' : '📝');
            const baseCls = isUrgent ? 'todo-item todo-urgent' : (isWarn ? 'todo-item todo-warn' : 'todo-item');
            const isActive = (this.isFocusModeActive && this.isFocusModeActive()) ? true : (i === this.activeTaskIndex);
            const isCompleted = task.completed ? 'is-completed' : '';
            const cls = isActive ? `${baseCls} is-active ${isCompleted}` : `${baseCls} ${isCompleted}`;
            const pct = Math.max(0, Math.min(100, Math.round((task.progress || 0) * 100)));
            const checkmark = task.completed ? '✓' : '○';
            html += `<div class="${cls}" data-task-idx="${i}" style="cursor:pointer;" onclick="window.adhs?.completeTask(${i})"><span class="todo-checkbox">${checkmark}</span><span class="todo-icon">${icon}</span><span class="todo-text">${text}</span><span class="todo-progress">${pct}%</span></div>`;
        });

        // Controller-Hilfe (eingebettet, damit alles in einem VR-Panel bleibt)
        html += `
            <details class="hud-help" data-quest-help="1">
                <summary>Meta Quest Controller – Hilfe</summary>
                <div class="hud-help__body">
                    <div><strong>Rechts:</strong> A = Start/Stop, B = Nachgeben, Trigger = Refocus</div>
                    <div><strong>Links:</strong> X = Level ↑, Y = Level ↓</div>
                    <div><strong>Stick (beide):</strong> Hoch/Runter = Level ±</div>
                </div>
            </details>
        `;
        todoDiv.innerHTML = html;
        this.taskPanel = todoDiv;

        this.updateVrHud();
    }

    // Panel aktualisieren (z.B. nach Hinzufügen/Entfernen)
    updateTaskPanel() {
        this.showTaskPanel();
    }

    // Aufgabe hinzufügen
    addTask(task) {
        const text = String(task || '').trim();
        if (!text) return;
        if (this.tasks) {
            this.tasks.push({ text, kind: 'misc', progress: 0, completed: false });
            this.taskList = this.tasks.map(t => t.text);
        } else {
            this.taskList.push(text);
        }
        this.updateTaskPanel();
    }

    // Aufgabe als erledigt markieren (Toggle)
    completeTask(idx) {
        if (this.tasks && idx >= 0 && idx < this.tasks.length) {
            this.tasks[idx].completed = !this.tasks[idx].completed;
            this.updateTaskPanel();
            this.playSoundFile('MultimediaNotify_S011TE.579.wav', { maxDuration: 0.6, volume: 0.3 });
            return;
        }
    }

    // Aufgabe entfernen (per Index)
    removeTask(idx) {
        if (this.tasks && idx >= 0 && idx < this.tasks.length) {
            this.tasks.splice(idx, 1);
            this.taskList = this.tasks.map(t => t.text);
            if (this.activeTaskIndex >= this.tasks.length) this.activeTaskIndex = Math.max(0, this.tasks.length - 1);
            this.updateTaskPanel();
            return;
        }
        if (idx >= 0 && idx < this.taskList.length) {
            this.taskList.splice(idx, 1);
            this.updateTaskPanel();
        }
    }

    // Panel beim Stoppen entfernen
    removeTaskPanel() {
        const todoDiv = document.getElementById('todo-ui');
        if (todoDiv && todoDiv.parentNode) {
            todoDiv.parentNode.removeChild(todoDiv);
        }
        this.taskPanel = null;

        this.updateVrHud();
    }

    // --- Aufgabe vs. Reiz: State + Helpers ---
    getActiveTask() {
        if (this.tasks && this.tasks.length) {
            return this.tasks[Math.max(0, Math.min(this.activeTaskIndex, this.tasks.length - 1))];
        }
        const text = (this.taskList && this.taskList.length) ? this.taskList[0] : 'Aufgabe';
        return { text, kind: 'misc', progress: 0 };
    }

    isHyperfocusActive() {
        return !!(this.active && !this.paused && this.distractionLevel > 0 && Date.now() < (this._hyperfocusUntil || 0));
    }

    isReentryActive() {
        return !!(this.active && !this.paused && this.distractionLevel > 0 && Date.now() < (this._reentryUntil || 0));
    }

    isRefocusShieldActive() {
        return !!(this.active && !this.paused && this.distractionLevel > 0 && Date.now() < (this._refocusShieldUntil || 0));
    }

    isRefocusHardLockActive() {
        return !!(this.active && !this.paused && this.distractionLevel > 0 && Date.now() < (this._refocusHardLockUntil || 0));
    }

    isFocusModeActive() {
        return !!(this.active && !this.paused && this.distractionLevel > 0 && Date.now() < (this._focusModeUntil || 0));
    }

    _habKey(kind, id) {
        return `${kind || 'x'}:${id || 'x'}`;
    }

    // Exponential-decay counter (half-life ~12s)
    _habGetCount(kind, id) {
        const entry = this._habituation && this._habituation.get(this._habKey(kind, id));
        if (!entry) return 0;
        const now = Date.now();
        const lastAt = entry.lastAt || now;
        const dt = Math.max(0, now - lastAt);
        const halfLife = 12000;
        const decay = Math.pow(0.5, dt / halfLife);
        return (entry.count || 0) * decay;
    }

    getHabituationFactor(kind, id) {
        const c = this._habGetCount(kind, id);
        const f = 1 / (1 + 0.65 * c);
        return Math.max(0.35, Math.min(1.0, f));
    }

    noteStimulus(kind, id) {
        if (!this._habituation) this._habituation = new Map();
        const key = this._habKey(kind, id);
        const now = Date.now();
        const decayed = this._habGetCount(kind, id);
        this._habituation.set(key, { count: decayed + 1, lastAt: now });
    }

    _getPrimaryFocusTarget() {
        const env = this.environment || this.detectEnvironment();
        const map = {
            // Schwellen bewusst enger: "Aufgabe im Blick behalten" soll sich klar anfühlen.
            // In der Praxis sind 16–18° oft zu streng (Headset-Micro-Jitter / große Targets).
            desk: { ids: ['monitor1-screen', 'monitor2-screen', 'monitor1', 'monitor2', 'desk'], thresholdDeg: 24 },
            hoersaal: { ids: ['lecture-screen-content', 'lecture-screen', 'prof', 'podium'], thresholdDeg: 22 },
            supermarkt: { ids: ['products', 'shelves', 'checkout', 'checkout2', 'views'], thresholdDeg: 26 }
        };
        const cfg = map[env] || map.desk;
        const els = [];
        for (const id of (cfg.ids || [])) {
            const el = document.getElementById(id);
            if (el && el.object3D) els.push(el);
        }
        if (!els.length) return null;
        return { els, thresholdDeg: cfg.thresholdDeg };
    }

    _getLookAwayInfo() {
        try {
            const cameraEl = document.querySelector('a-camera') || document.querySelector('[camera]');
            if (!cameraEl || !cameraEl.object3D) return null;

            const target = this._getPrimaryFocusTarget();
            if (!target || !Array.isArray(target.els) || !target.els.length) return null;

            // THREE ist via A-Frame global verfügbar
            const camPos = new THREE.Vector3();
            const camDir = new THREE.Vector3();
            const tgtPos = new THREE.Vector3();

            cameraEl.object3D.getWorldPosition(camPos);
            cameraEl.object3D.getWorldDirection(camDir);
            let bestAngleDeg = Infinity;
            let bestPos = null;
            for (const el of target.els) {
                if (!el || !el.object3D) continue;
                el.object3D.getWorldPosition(tgtPos);
                const toTarget = tgtPos.clone().sub(camPos);
                const len = toTarget.length();
                if (!isFinite(len) || len < 0.0001) continue;
                toTarget.normalize();
                const dot = Math.max(-1, Math.min(1, camDir.dot(toTarget)));

                // Ziele hinter Kopf/Kamera ignorieren.
                // Verhindert "Flip"-Effekte, wenn ein großes Objekt einen Pivot hinter dem User hat.
                if (dot <= 0.02) continue;

                const angleDeg = Math.acos(dot) * (180 / Math.PI);
                if (angleDeg < bestAngleDeg) {
                    bestAngleDeg = angleDeg;
                    bestPos = { x: tgtPos.x, y: tgtPos.y, z: tgtPos.z };
                }
            }
            if (!isFinite(bestAngleDeg)) return null;

            const thresholdDeg = typeof target.thresholdDeg === 'number' ? target.thresholdDeg : 24;
            return {
                angleDeg: bestAngleDeg,
                thresholdDeg,
                isLookingAway: bestAngleDeg > thresholdDeg,
                focusTargetPos: bestPos
            };
        } catch (e) {
            return null;
        }
    }

    setTaskState(state, durationMs = 0) {
        this.taskState = state;
        this._lastTaskStateChangeAt = Date.now();
        this.taskStateUntil = durationMs > 0 ? (Date.now() + durationMs) : 0;
        this.updateTaskPanel();
        this.updateVrHud();
    }

    startTaskTicking() {
        this.stopTaskTicking();
        this._taskTickInterval = setInterval(() => this.tickTaskLoop(), 900);
    }

    stopTaskTicking() {
        if (this._taskTickInterval) {
            clearInterval(this._taskTickInterval);
            this._taskTickInterval = null;
        }
    }

    // =============================================================
    // Task Loop (Herzstück der „ADHS-Mechanik“)
    // Läuft ca. alle 0,9s und simuliert den inneren Ablauf:
    // - idle → procrastinating: „Anfangen ist schwer“
    // - working: Fortschritt steigt (aber Unterbrechungen passieren)
    // - hyperfocus: selten, aber schneller Fortschritt („Tunnel“)
    // Zusätzlich:
    // - Look-away Heuristik: Wegschauen von „Fokus-Zielen“ erhöht Stress
    // - Refocus-/GiveIn-Events verändern State, Stress und Progress
    // =============================================================
    tickTaskLoop() {
        if (!this.active || this.paused || this.distractionLevel <= 0) {
            // Wenn die Simulation aus ist: alle temporären Effekte/States zurücksetzen (sonst "hängen" Cues beim nächsten Start).
            this.taskState = 'idle';
            this._hyperfocusUntil = 0;
            this._reentryUntil = 0;
            this._timeBlindnessUntil = 0;
            this._timeBlindnessMsg = '';
            this._lookAwayMs = 0;
            this._lookAwayLastAt = 0;
            this._isLookingAway = false;
            this.updateVrHud();
            return;
        }

        const now = Date.now();
        const level = this.distractionLevel;
        const task = this.getActiveTask();

        const clamp01 = (v) => Math.max(0, Math.min(1, v));

        // Initial: erst mal "Starten" fällt schwer
        if (this.taskState === 'idle') {
            // Initiationsbarriere: das System startet fast immer mit Prokrastination.
            this.setTaskState('procrastinating', 3500 + Math.random() * 6500);
            return;
        }

        // Timed transitions
        if (this.taskStateUntil && now >= this.taskStateUntil) {
            if (this.taskState === 'procrastinating') {
                // Wieder reinfinden ist schwer: nach Prokrastination kurze Re-Entry-Phase
                const reentryByLevel = [0, 1800, 2600, 3400];
                this._reentryUntil = now + (reentryByLevel[level] || 2400) + Math.random() * 1200;
                this.setTaskState('working', 0); // Zurück in "Working" – aber mit Re-Entry-Kosten im Hintergrund.
                // Direkt nach dem "Anfangen" kommt oft sofort ein kleiner Reiz
                if (this.environment === 'desk') this.createMonitorMicroDistraction({ reason: 'reentry' });
                else this.showNotification({ reason: 'reentry' });
            } else if (this.taskState === 'hyperfocus') {
                // Nach Hyperfokus oft kurzer "Crash"
                this._hyperfocusUntil = 0;
                this.setTaskState('procrastinating', 1800 + Math.random() * 3500);
            }
        }

        // Hyperfokus Startchance (selten, aber spürbar)
        const canHyperfocus = (now - (this._lastHyperfocusAt || 0)) > 25000;
        const isWorking = this.taskState === 'working';
        const baseHyperfocusChance = (level === 1 ? 0.06 : level === 2 ? 0.05 : 0.04);
        let hyperfocusChance = baseHyperfocusChance;
        if (now < (this._refocusBoostUntil || 0)) {
            hyperfocusChance = Math.min(0.085, hyperfocusChance + (this._refocusBoost || 0));
        }
        if (isWorking && canHyperfocus && Math.random() < hyperfocusChance) {
            this._lastHyperfocusAt = now;
            const dur = 12000 + Math.random() * 14000;
            this._hyperfocusUntil = now + dur;
            this.setTaskState('hyperfocus', dur);
        }

        // Interruption / task switching ("dranbleiben" schwer)
        if (this.taskState === 'working' && Math.random() < (level === 1 ? 0.12 : level === 2 ? 0.18 : 0.26)) {
            // Unterbrechung fühlt sich nachher wie "wieder neu anfangen" an
            const reentryByLevel = [0, 2200, 3200, 4400];
            this._reentryUntil = now + (reentryByLevel[level] || 3200) + Math.random() * 1600;
            this.stress = clamp01((this.stress || 0) + (0.06 + 0.03 * level)); // Task-Switching-Kosten: Stress steigt durch Unterbrechung.
            this.setTaskState('procrastinating', 2200 + Math.random() * 5200);
            // "Reiz" sofort sichtbar machen
            if (this.environment === 'desk') this.createMonitorMicroDistraction({ reason: 'interrupt' });
            else this.showNotification({ reason: 'interrupt' });
            return;
        }

        // Blick weg von der Aufgabe -> sofortiges Feedback + Stress steigt (nur wenn man eigentlich arbeitet)
        // Heuristik: kleinster Winkel zwischen Kamerarichtung und erlaubten "Aufgaben-Zielen" (je Umgebung)
        const inFocusWorkNow = (this.taskState === 'working' || this.taskState === 'hyperfocus');
        if (!this._lookAwayLastAt) this._lookAwayLastAt = now;
        const lookDtRaw = Math.max(0, now - (this._lookAwayLastAt || now));
        const lookDt = Math.min(2000, lookDtRaw);
        this._lookAwayLastAt = now;

        if (inFocusWorkNow) {
            const info = this._getLookAwayInfo();

            // Smooth the angle a bit to avoid false positives from micro head jitter.
            // EMA reacts fast enough for UX but prevents single-frame spikes.
            if (info) {
                const alpha = 0.35;
                if (typeof this._focusAngleEma !== 'number' || !isFinite(this._focusAngleEma)) {
                    this._focusAngleEma = info.angleDeg;
                } else {
                    this._focusAngleEma = (alpha * info.angleDeg) + ((1 - alpha) * this._focusAngleEma);
                }
            } else {
                this._focusAngleEma = null;
            }

            // Hysterese, damit "an der Kante" nicht flackert: zum Aktivieren muss man deutlicher weg,
            // zum Deaktivieren muss man wieder klar zurück in den Fokus.
            const marginDeg = 4;
            let isAwayNow = false;
            if (info) {
                const angleDeg = (typeof this._focusAngleEma === 'number' && isFinite(this._focusAngleEma)) ? this._focusAngleEma : info.angleDeg;
                if (this._isLookingAway) {
                    isAwayNow = angleDeg > (info.thresholdDeg - marginDeg);
                } else {
                    isAwayNow = angleDeg > (info.thresholdDeg + marginDeg);
                }
            }

            if (isAwayNow) {
                // Grace-Time: erst nach kurzem "wirklich weg" bestrafen.
                // Das verhindert, dass es sich so anfühlt als würde es "random" triggern.
                const graceMsByEnv = { desk: 1100, hoersaal: 1100, supermarkt: 900 };
                const graceMs = graceMsByEnv[this.environment] || 1000;

                if (!this._isLookingAway) {
                    this._lookAwayMs = 0;
                    this._lastLookAwayMsgAt = now;
                    this._lookAwayPenaltyActive = false;
                }
                this._isLookingAway = true;
                this._lookAwayMs = (this._lookAwayMs || 0) + lookDt;

                // During grace time: track it, but don't punish yet.
                if ((this._lookAwayMs || 0) < graceMs) {
                    return;
                }

                // Kontextsensitives Feedback (nur einmal pro "Wegschauen"-Episode, sobald es wirklich zählt)
                if (!this._lookAwayPenaltyActive) {
                    this._lookAwayPenaltyActive = true;

                    // Kurzer visueller Impuls: "du driftest weg" (orange)
                    try { this.createScreenTint(650, '#f59e0b'); } catch (e) {}

                    // Zeige einen dezenten Cue zurück zum Fokus-Ziel (Monitor/Prof/Regal)
                    try {
                        const pos = info && info.focusTargetPos;
                        if (pos && typeof this.createGazeCue === 'function') {
                            this.createGazeCue(pos.x, pos.y, pos.z, 900);
                        }
                    } catch (e) {}
                }

                // Erst jetzt Feedback + Stress.
                if ((now - (this._lastLookAwayMsgAt || 0)) > 700) {
                    this._lastLookAwayMsgAt = now;
                    this._actionMsg = 'Blick weg von Aufgabe → Stress +';
                    this._actionMsgUntil = now + 1200;
                }

                const dtSec = lookDt / 1000;
                const awaySec = Math.max(0, (this._lookAwayMs || 0) / 1000);
                const baseRatePerSec = 0.006 + 0.003 * level; // unmittelbarer "Kosten"-Druck
                const ramp = Math.min(2.2, 1.0 + (awaySec / 6)); // je länger weg, desto mehr Stress (ADHS: Re-Entry wird schwer)
                const angleNow = (info && typeof this._focusAngleEma === 'number' && isFinite(this._focusAngleEma)) ? this._focusAngleEma : (info ? info.angleDeg : 0);
                const overshoot = info ? Math.max(0, (angleNow - info.thresholdDeg)) : 0;
                const angleFactor = Math.min(2.0, 1.0 + (overshoot / 18));
                this.stress = clamp01((this.stress || 0) + (baseRatePerSec * dtSec * ramp * angleFactor));
            } else {
                // Zurueck im Fokus: kurzes positives Feedback
                if (this._isLookingAway && this._lookAwayPenaltyActive) {
                    this._actionMsg = 'Zurueck im Fokus ✓';
                    this._actionMsgUntil = now + 900;
                    try { this.createScreenTint(450, '#22c55e'); } catch (e) {}
                    this.stress = clamp01((this.stress || 0) - 0.010);
                }

                this._isLookingAway = false;
                this._lookAwayMs = 0;
                this._lookAwayPenaltyActive = false;
            }
        } else {
            this._isLookingAway = false;
            this._lookAwayMs = 0;
            this._lookAwayPenaltyActive = false;
        }

        // Stress-Drift (spürbar, aber nicht extrem)
        if (this.taskState === 'procrastinating') {
            this.stress = clamp01((this.stress || 0) + (0.0025 + 0.0015 * level));
        } else if (this.taskState === 'working') {
            this.stress = clamp01((this.stress || 0) - 0.002);
        } else if (this.taskState === 'hyperfocus') {
            this.stress = clamp01((this.stress || 0) - 0.003);
        }

        // Progress: in Hyperfokus schneller, sonst langsam + abhängig vom Level
        const base = this.taskState === 'hyperfocus' ? 0.040 : 0.015;
        const levelPenalty = level === 1 ? 1.0 : level === 2 ? 0.80 : 0.62;
        const kindBonus = (task.kind === 'deepwork') ? 0.75 : (task.kind === 'chores') ? 0.90 : 1.0;
        const reentryFactor = (this.taskState === 'working' && this.isReentryActive()) ? 0.35 : 1.0;
        const stressFactor = Math.max(0.45, 1.0 - 0.45 * (this.stress || 0));
        const inc = base * levelPenalty * kindBonus * reentryFactor * stressFactor;
        if (this.taskState === 'working' || this.taskState === 'hyperfocus') {
            task.progress = Math.min(1, (task.progress || 0) + inc);
        }

        // Background-Progress: damit man Aufgaben nicht manuell "abhaken" muss.
        // Nicht-aktive Tasks laufen deutlich langsamer, aber werden ueber Zeit fertig.
        if (this.tasks && this.tasks.length) {
            const baseBg = (this.taskState === 'hyperfocus') ? 0.006
                : (this.taskState === 'working') ? 0.0035
                : (this.taskState === 'procrastinating') ? 0.0009
                : 0;

            if (baseBg > 0) {
                for (let i = 0; i < this.tasks.length; i++) {
                    if (i === this.activeTaskIndex) continue;
                    const t = this.tasks[i];
                    if (!t || t.completed) continue;

                    const tKindBonus = (t.kind === 'deepwork') ? 0.75 : (t.kind === 'chores') ? 0.90 : 1.0;
                    const bgInc = baseBg * levelPenalty * tKindBonus * stressFactor;
                    t.progress = Math.min(1, (t.progress || 0) + bgInc);

                    if ((t.progress || 0) >= 1 && !t.completed) {
                        t.completed = true;
                        t.progress = 1.0;
                    }
                }
            }
        }

        // Zeitblindheit: besonders in Hyperfokus/Arbeit "vergeht" Zeit unbemerkt
        const timeBlindnessCooldownOk = (now - (this._lastTimeBlindnessAt || 0)) > 45000;
        const inFocusWork = (this.taskState === 'working' || this.taskState === 'hyperfocus');
        if (timeBlindnessCooldownOk && inFocusWork) {
            const baseChance = (this.taskState === 'hyperfocus') ? 0.016 : 0.007;
            const levelBoost = (level === 1 ? 0.85 : level === 2 ? 1.0 : 1.15);
            if (Math.random() < (baseChance * levelBoost)) {
                this._lastTimeBlindnessAt = now;
                const lostMin = 5 + Math.floor(Math.random() * 21); // 5..25
                this._timeBlindnessMsg = `Zeitblindheit: +${lostMin} Min`;
                this._timeBlindnessUntil = now + 4200;
                this.stress = clamp01((this.stress || 0) + 0.04);
            }
        }

        // Task completion: erreicht 100% → als erledigt markieren + Feedback
        if ((task.progress || 0) >= 1 && !task.completed) {
            task.completed = true;
            task.progress = 1.0;
            // Celebration-Sound abspielen
            this.playSoundFile('MultimediaNotify_S011TE.579.wav', { maxDuration: 0.8, volume: 0.5 });
            this._actionMsg = '✓ Task erledigt!';
            this._actionMsgUntil = Date.now() + 2000;

            // Automatisch zur naechsten un-erledigten Aufgabe springen
            if (this.tasks && this.tasks.length) {
                const len = this.tasks.length;
                const startIdx = Math.max(0, Math.min(Number(this.activeTaskIndex) || 0, len - 1));
                let nextIdx = startIdx;
                for (let step = 1; step <= len; step++) {
                    const cand = (startIdx + step) % len;
                    const tt = this.tasks[cand];
                    if (tt && !tt.completed) {
                        nextIdx = cand;
                        break;
                    }
                }
                this.activeTaskIndex = nextIdx;
            }

            // Kurze Entspannungs-Phase nach Completion
            this.setTaskState('procrastinating', 800 + Math.random() * 1200);
        }

        this.updateTaskPanel();
        this.updateVrHud();
    }

    // =============================================================
    // VR UI: DOM-Overlay vs. VR-HUD (Fallback)
    // - Wenn WebXR DOM-Overlay verfügbar ist, bleibt #ui-overlay im Headset sichtbar.
    // - Wenn nicht, bauen wir ein kleines HUD als A-Frame Entities an die Kamera.
    // - Zusätzlich togglen wir html.in-vr, damit CSS (Overlay ausblenden, Cursor weg) greift.
    // =============================================================
    installVrHudOnce() {
        if (this._vrHudInstalled) return;

        const scene = document.querySelector('a-scene');
        if (!scene) {
            this._vrHudRetryCount = (this._vrHudRetryCount || 0) + 1;
            if (this._vrHudRetryCount > 40) return; // ~8s, danach aufgeben
            // Szene ist beim Script-Load evtl. noch nicht im DOM: später nochmal versuchen
            setTimeout(() => this.installVrHudOnce(), 200);
            return;
        }

        this._vrHudInstalled = true;

        // Robustheit: Manche Browser/Headsets feuern "exit-vr" nicht zuverlässig.
        // Daher synchronisieren wir den VR-Status zusätzlich per Polling.
        const syncVrState = () => {
            try {
                let inVr = false;
                try {
                    // A-Frame State (kann in Edge-Cases hängen bleiben)
                    inVr = !!(scene && scene.is && scene.is('vr-mode'));
                } catch (e) {
                    inVr = false;
                }

                // Three.js / WebXR ist die verlässlichere Quelle: aktive Session bzw. isPresenting.
                try {
                    const xr = scene && scene.renderer && scene.renderer.xr;
                    const session = xr && xr.getSession && xr.getSession();
                    if (session) inVr = true;
                    if (xr && xr.isPresenting) inVr = true;
                } catch (e) {}

                if (inVr) {
                    // Marker für CSS: "wir sind in VR" (z.B. Buttons ausblenden, Cursor verstecken)
                    try { document.documentElement.classList.add('in-vr'); } catch (e) {}
                    // Air Link / Desktop-WebXR: immer VR-HUD verwenden (DOM-Overlay ist dort nicht sichtbar).
                    this._vrInterfaceMode = 'hud';
                    if (!this._vrHud && !this._vrHudPending) {
                        this._vrHudPending = true;
                        setTimeout(() => {
                            this._vrHudPending = false;
                            this.createVrHudLite();
                            this.updateVrHud();
                        }, 900);
                    }
                    return;
                }

                // Zurück im Desktop: Klasse entfernen und VR-HUD wegräumen (außer Debug-HUD ist explizit an).
                // Zurück in Desktop: VR-Marker entfernen
                try { document.documentElement.classList.remove('in-vr'); } catch (e) {}
                if (!this._vrHudDebug) {
                    this._vrInterfaceMode = null;
                    this.removeVrHud();
                }
            } catch (e) {
                // ignorieren
            }

        }

        if (!this._vrStateSyncInterval) {
            this._vrStateSyncInterval = setInterval(syncVrState, 450);
            try {
                window.addEventListener('visibilitychange', syncVrState);
                window.addEventListener('focus', syncVrState);
                window.addEventListener('blur', syncVrState);
            } catch (e) {}
        }

        scene.addEventListener('enter-vr', () => {
            try { document.documentElement.classList.add('in-vr'); } catch (e) {}

            // VR-Starthinweis (optional): per URL ?vrHint=1 aktivieren, sonst aus (Quest-Performance).
            try {
                const qs = String((window.location && window.location.search) || '');
                const showHint = /[?&](vrHint|showHint)=1(\b|&|$)/.test(qs);
                if (showHint) setTimeout(() => this.showVrStartHint({ autoHideMs: 6500 }), 900);
            } catch (e) {}

            // Air Link / Desktop-WebXR: DOM-Overlay ist nicht sichtbar -> VR-HUD (Lite) erzwingen.
            this._vrInterfaceMode = 'hud';
            if (!this._vrHud && !this._vrHudPending) {
                this._vrHudPending = true;
                setTimeout(() => {
                    this._vrHudPending = false;
                    this.createVrHudLite();
                    this.updateVrHud();
                }, 1200);
            }

            // Zeige eine ausführliche Welcome-Card mit Steuerungshinweisen.
            setTimeout(() => this.showVrWelcomeCard({ autoHideMs: 18000 }), 700);
        });

        scene.addEventListener('exit-vr', () => {
            try { document.documentElement.classList.remove('in-vr'); } catch (e) {}
            this._vrInterfaceMode = null;
            this._vrHudPending = false;
            this.removeVrHud();

            // Falls der Hint gerade sichtbar ist: sauber entfernen.
            try {
                const old = document.getElementById('adhs-vr-start-hint');
                if (old && old.parentNode) old.parentNode.removeChild(old);
            } catch (e) {}

            try {
                const welcome = document.getElementById('adhs-vr-welcome');
                if (welcome && welcome.parentNode) welcome.parentNode.removeChild(welcome);
            } catch (e) {}
        });
    }

    getPreferredVrHudScale() {
        if (this._vrHudScalePreference) return this._vrHudScalePreference;

        let scale = 1.6;
        try {
            if (typeof window !== 'undefined') {
                if (typeof window.__DESYNC_VR_HUD_SCALE !== 'undefined') {
                    const custom = Number(window.__DESYNC_VR_HUD_SCALE);
                    if (!Number.isNaN(custom) && custom > 0) scale = custom;
                } else if (window.location && window.location.search) {
                    const params = new URLSearchParams(window.location.search);
                    const qsValue = params.get('vrHudScale');
                    if (qsValue !== null) {
                        const parsed = Number(qsValue);
                        if (!Number.isNaN(parsed) && parsed > 0) scale = parsed;
                    }
                }
            }
        } catch (e) {}

        this._vrHudScalePreference = Math.max(1.0, Math.min(2.2, scale));
        return this._vrHudScalePreference;
    }

    showVrStartHint(opts = {}) {
        try {
            const scene = document.querySelector('a-scene');
            const camera = document.querySelector('a-camera') || document.querySelector('[camera]') || (scene && scene.camera && scene.camera.el);
            if (!camera) {
                setTimeout(() => this.showVrStartHint(opts), 200);
                return;
            }

            const autoHideMs = Math.max(2500, Math.min(20000, Number(opts.autoHideMs) || 9000));

            const env = this.environment || this.detectEnvironment();
            const envTitle = {
                desk: 'Schreibtisch',
                hoersaal: 'Hörsaal',
                supermarkt: 'Supermarkt'
            }[env] || 'Simulation';

            // Remove old (damit es bei mehrfachen Triggers nicht stapelt)
            try {
                const old = document.getElementById('adhs-vr-start-hint');
                if (old && old.parentNode) old.parentNode.removeChild(old);
            } catch (e) {}

            const panel = document.createElement('a-entity');
            panel.setAttribute('id', 'adhs-vr-start-hint');
            panel.setAttribute('position', '0 0.18 -1.05');
            panel.setAttribute('scale', '1 1 1');

            const bg = document.createElement('a-plane');
            bg.setAttribute('width', '1.30');
            bg.setAttribute('height', '0.48');
            bg.setAttribute('position', '0 0 0');
            bg.setAttribute('material', 'shader:flat; transparent:true; opacity:0.82; color:#0b1220; depthTest:false; depthWrite:false');

            const title = document.createElement('a-troika-text');
            title.setAttribute('value', `Kurzinfo – ${envTitle}`);
            title.setAttribute('max-width', '1.22');
            title.setAttribute('font-size', '0.048');
            title.setAttribute('color', '#e2e8f0');
            title.setAttribute('position', '-0.60 0.190 0.01');
            title.setAttribute('align', 'left');
            title.setAttribute('anchor', 'left');
            title.setAttribute('baseline', 'center');

            const body = document.createElement('a-troika-text');
            body.setAttribute(
                'value',
                'Diese Simulation soll zeigen: ADHS ist mehr als „schlecht konzentrieren“.\n'
                + '• Starten & Planen können schwer sein.\n'
                + '• Reizfilter kostet Energie (viele Reize gleichzeitig).\n'
                + '• Wiedereinstieg nach Unterbrechungen ist teuer.\n'
                + '• Zeitblindheit & Stress verstärken das.\n'
                + 'Steuerung: Mit Controller‑Laser auf UI zeigen + Trigger klicken.\n'
                + 'Tasten: R=Refocus • G=Nachgegeben • O=Start/Stop • +/-=Intensität'
            );
            body.setAttribute('max-width', '1.22');
            body.setAttribute('font-size', '0.030');
            body.setAttribute('line-height', '1.20');
            body.setAttribute('color', '#cbd5e1');
            body.setAttribute('position', '-0.60 0.130 0.01');
            body.setAttribute('align', 'left');
            body.setAttribute('anchor', 'left');
            body.setAttribute('baseline', 'top');

            panel.appendChild(bg);
            panel.appendChild(title);
            panel.appendChild(body);
            camera.appendChild(panel);

            // Sicherstellen, dass das Panel vor Welt-Geometrie gerendert wird.
            const applyOrdering = () => {
                try {
                    panel.object3D.traverse((o) => {
                        o.renderOrder = 1250;
                        if (o.material) {
                            o.material.depthTest = false;
                            o.material.depthWrite = false;
                            o.material.transparent = true;
                        }
                    });
                } catch (e) {}
            };
            setTimeout(applyOrdering, 0);
            setTimeout(applyOrdering, 250);
            // Weniger Wiederholungen = weniger Main-Thread-Spikes beim XR-Start

            setTimeout(() => {
                try { if (panel && panel.parentNode) panel.parentNode.removeChild(panel); } catch (e) {}
            }, autoHideMs);
        } catch (e) {
            // ignorieren
        }
    }

    showVrWelcomeCard(opts = {}) {
        try {
            const scene = document.querySelector('a-scene');
            if (!scene) return;

            const autoHideMs = Math.max(8000, Number(opts.autoHideMs) || 18000);
            try {
                const existing = document.getElementById('adhs-vr-welcome');
                if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
            } catch (e) {}

            const card = document.createElement('a-entity');
            card.setAttribute('id', 'adhs-vr-welcome');
            card.setAttribute('scale', '1.2 1.2 1.2');
            card.setAttribute('hud-stabilize', 'distance: 1.05; height: 0.30; followSpeed: 0.2; yawOnly: true');

            const commonMat = 'shader:flat; transparent:true; depthTest:false; depthWrite:false';
            const controlLines = 'Trigger · Buttons tippen\nThumbstick · HUD ausrichten\nA · Start/Stop\nB · Nachgeben melden\nX/Y · Level ±\nGrip · Aufgabenfokus halten';

            card.innerHTML = `
                <a-plane width="1.20" height="0.64" material="color:#020617; opacity:0.94; ${commonMat}" position="0 0 -0.004"></a-plane>
                <a-plane width="1.20" height="0.012" material="color:#38bdf8; opacity:0.98; ${commonMat}" position="0 0.275 0"></a-plane>
                <a-troika-text value="Willkommen in DeSync VR" max-width="1.08" font-size="0.060" color="#f8fafc" position="-0.50 0.205 0.006" align="left" anchor="left" baseline="center"></a-troika-text>
                <a-troika-text value="So steuerst du im Headset:" max-width="1.08" font-size="0.034" color="#e2e8f0" position="-0.50 0.145 0.006" align="left" anchor="left" baseline="center"></a-troika-text>
                <a-troika-text value="${controlLines}" max-width="1.08" font-size="0.030" color="#cbd5e1" position="-0.50 0.020 0.006" align="left" anchor="left" baseline="top" line-height="1.25"></a-troika-text>
                <a-troika-text value="Ziel: Aufgaben fokussieren, Ablenkungen wahrnehmen und mit Refocus reagieren." max-width="1.10" font-size="0.030" color="#f8fafc" position="-0.50 -0.210 0.006" align="left" anchor="left" baseline="center"></a-troika-text>
                <a-troika-text value="Hinweis blendet sich gleich automatisch aus." max-width="1.10" font-size="0.024" color="#cbd5e1" position="-0.50 -0.255 0.006" align="left" anchor="left" baseline="center"></a-troika-text>
            `;

            scene.appendChild(card);

            const hide = () => {
                try {
                    if (card && card.parentNode) card.parentNode.removeChild(card);
                } catch (e) {}
            };

            setTimeout(hide, autoHideMs);
        } catch (e) {}
    }

    runVrHudAction(action) {
        try {
            switch (String(action || '')) {
                case 'level-up':
                    if (this.distractionLevel < 3) this.start(this.distractionLevel + 1);
                    this.paused = false;
                    break;
                case 'level-down':
                    if (this.distractionLevel > 0) this.start(this.distractionLevel - 1);
                    break;
                case 'toggle':
                    if (this.active && !this.paused) {
                        this.paused = true;
                        this.stop();
                    } else {
                        const level = this.distractionLevel && this.distractionLevel > 0 ? this.distractionLevel : 1;
                        this.start(level);
                        this.paused = false;
                    }
                    break;
                case 'give-in':
                    if (typeof this.handleUserGaveIn === 'function') {
                        this.handleUserGaveIn({ type: 'manual', label: 'Nachgegeben', severity: 1.0 });
                    }
                    break;
                case 'refocus':
                    if (typeof this.handleUserRefocus === 'function') {
                        this.handleUserRefocus();
                    }
                    break;
                default:
                    break;
            }
        } catch (e) {}

        try { this.updateVrHud(); } catch (e) {}
    }

    bindVrHudButton(el, action) {
        if (!el) return;
        if (el.__adhsVrHudBound) return;
        el.__adhsVrHudBound = true;

        try {
            this.ensureMouseRayCursor();
        } catch (e) {}

        try {
            el.classList.add('clickable');
            el.classList.add('adhs-clickable');
        } catch (e) {}

        const base = el.getAttribute('data-base-color') || '#e2e8f0';
        const hover = el.getAttribute('data-hover-color') || '#bfdbfe';

        el.addEventListener('mouseenter', () => {
            try { el.setAttribute('material', 'color', hover); } catch (e) {}
        });
        el.addEventListener('mouseleave', () => {
            try { el.setAttribute('material', 'color', base); } catch (e) {}
        });
        el.addEventListener('click', (ev) => {
            try { ev && ev.stopPropagation && ev.stopPropagation(); } catch (e) {}
            this.runVrHudAction(action);
        });
    }

    buildVrHudControls(root) {
        if (!root || root.querySelector('#vr-hud-controls-panel')) return;

        const panel = document.createElement('a-entity');
        panel.setAttribute('id', 'vr-hud-controls-panel');
        panel.setAttribute('position', '0 0 0.01');
        panel.setAttribute('scale', '1 1 1');

        const commonMat = 'shader:flat; transparent:true; depthTest:false; depthWrite:false';

        const bg = document.createElement('a-plane');
        bg.setAttribute('width', '1.02');
        bg.setAttribute('height', '0.18');
        bg.setAttribute('position', '0 0 -0.004');
        bg.setAttribute('material', `color:#0b1220; opacity:0.75; ${commonMat}`);
        panel.appendChild(bg);

        const mkBtn = (id, label, x, action, color, hover, textId) => {
            const btn = document.createElement('a-plane');
            btn.setAttribute('id', id);
            btn.setAttribute('width', '0.18');
            btn.setAttribute('height', '0.085');
            btn.setAttribute('position', `${x} 0 0.002`);
            btn.setAttribute('material', `color:${color}; opacity:0.95; ${commonMat}`);
            btn.setAttribute('data-base-color', color);
            btn.setAttribute('data-hover-color', hover);

            const txt = document.createElement('a-troika-text');
            if (textId) txt.setAttribute('id', textId);
            txt.setAttribute('value', label);
            txt.setAttribute('max-width', '0.16');
            txt.setAttribute('font-size', '0.036');
            txt.setAttribute('color', '#f8fafc');
            txt.setAttribute('position', '0 0 0.01');
            txt.setAttribute('align', 'center');
            txt.setAttribute('anchor', 'center');
            txt.setAttribute('baseline', 'center');
            btn.appendChild(txt);

            panel.appendChild(btn);
            this.bindVrHudButton(btn, action);
        };

        mkBtn('vr-hud-btn-dec', '−', -0.40, 'level-down', '#111827', '#1f2937');
        mkBtn('vr-hud-btn-inc', '+', -0.20, 'level-up', '#111827', '#1f2937');
        mkBtn('vr-hud-btn-toggle', 'Start', 0.00, 'toggle', '#0f172a', '#1f2937', 'vr-hud-btn-toggle-text');
        mkBtn('vr-hud-btn-givein', 'Nachg.', 0.20, 'give-in', '#0f172a', '#1f2937');
        mkBtn('vr-hud-btn-refocus', 'Refocus', 0.40, 'refocus', '#0f172a', '#1f2937');

        const help = document.createElement('a-troika-text');
        help.setAttribute('id', 'vr-hud-controls-help');
        help.setAttribute('value', 'Laser + Trigger · A Start/Stop · B Nachgeben · X/Y Level · Stick ±');
        help.setAttribute('max-width', '1.0');
        help.setAttribute('font-size', '0.024');
        help.setAttribute('color', '#cbd5e1');
        help.setAttribute('position', '0 -0.065 0.01');
        help.setAttribute('align', 'center');
        help.setAttribute('anchor', 'center');
        help.setAttribute('baseline', 'center');
        panel.appendChild(help);

        root.appendChild(panel);
    }

    createVrHudLite() {
        if (this._vrHud) return;
        const scene = document.querySelector('a-scene');
        const camera = (scene && scene.camera && scene.camera.el) ? scene.camera.el : (document.querySelector('[camera]') || document.querySelector('a-camera'));
        if (!camera) {
            setTimeout(() => this.createVrHudLite(), 200);
            return;
        }

        const root = document.createElement('a-entity');
        root.setAttribute('id', 'vr-hud');
        root.setAttribute('position', '0 0 0');
        root.setAttribute('rotation', '0 0 0');
        const hudScale = this.getPreferredVrHudScale();
        this._vrHudScaleActive = hudScale;
        root.setAttribute('scale', `${hudScale} ${hudScale} ${hudScale}`);
        root.setAttribute('hud-stabilize', 'distance: 1.25; height: 0.12; followSpeed: 0.18; yawOnly: true');

        const commonMat = 'shader:flat; transparent:true; depthTest:false; depthWrite:false';

        // Minimal-HUD: wenige Elemente, damit VR-Start nicht „hängt“.
        // IDs bleiben kompatibel zu updateVrHud().

        const todoPanel = document.createElement('a-entity');
        todoPanel.setAttribute('id', 'vr-hud-todo-panel');
        todoPanel.setAttribute('position', '-0.55 -0.30 0.01');
        todoPanel.innerHTML = `
            <a-plane width="0.860" height="0.520" material="color:#060c1c; opacity:0.88; ${commonMat}" position="0 0 -0.004"></a-plane>
            <a-plane width="0.860" height="0.012" material="color:#38bdf8; opacity:0.98; ${commonMat}" position="0 0.245 0.000"></a-plane>
            <a-troika-text value="📝 To-Do" max-width="0.82" font-size="0.050" color="#f8fafc" position="-0.36 0.205 0.006" align="left" anchor="left" baseline="center"></a-troika-text>
            <a-troika-text id="vr-hud-subtitle-text" value="" max-width="0.82" font-size="0.030" color="#e2e8f0" position="-0.36 0.163 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.96"></a-troika-text>
            <a-troika-text id="vr-hud-metrics-text" value="" max-width="0.82" font-size="0.026" color="#cbd5e1" position="-0.36 0.128 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.94"></a-troika-text>
            <a-troika-text id="vr-hud-todo-text" value="" max-width="0.82" font-size="0.034" color="#e2e8f0" position="-0.36 0.082 0.006" align="left" anchor="left" baseline="top" line-height="1.25" fill-opacity="0.96"></a-troika-text>
        `;

        const levelPanel = document.createElement('a-entity');
        levelPanel.setAttribute('id', 'vr-hud-level-panel');
        levelPanel.setAttribute('position', '0.55 -0.30 0.01');
        levelPanel.innerHTML = `
            <a-plane width="0.700" height="0.520" material="color:#060c1c; opacity:0.88; ${commonMat}" position="0 0 -0.004"></a-plane>
            <a-plane width="0.700" height="0.012" material="color:#38bdf8; opacity:0.92; ${commonMat}" position="0 0.245 0.000"></a-plane>
            <a-troika-text value="🎮 ADHS" max-width="0.62" font-size="0.046" color="#f8fafc" position="-0.26 0.205 0.006" align="left" anchor="left" baseline="center"></a-troika-text>
            <a-troika-text value="Intensität:" max-width="0.62" font-size="0.032" color="#e2e8f0" position="-0.26 0.150 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.94"></a-troika-text>

            <a-plane id="vr-hud-level-chip-border" width="0.286" height="0.091" material="color:#1f2937; opacity:0.78; ${commonMat}" position="0.152 0.110 -0.002"></a-plane>
            <a-plane id="vr-hud-level-chip" width="0.280" height="0.087" material="color:#0f172a; opacity:0.92; ${commonMat}" position="0.150 0.110 -0.001"></a-plane>
            <a-troika-text id="vr-hud-level-chip-text" value="Aus" max-width="0.26" font-size="0.038" color="#0b1220" position="0.150 0.110 0.006" align="center" anchor="center" baseline="center"></a-troika-text>

            <a-troika-text id="vr-hud-focus-text" value="" max-width="0.62" font-size="0.028" color="#cbd5e1" position="-0.26 0.055 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.92"></a-troika-text>
            <a-troika-text id="vr-hud-active-task-text" value="" max-width="0.62" font-size="0.032" color="#f8fafc" position="-0.26 0.012 0.006" align="left" anchor="left" baseline="center"></a-troika-text>

            <a-plane width="0.56" height="0.028" material="color:#0f172a; opacity:0.55; ${commonMat}" position="-0.01 -0.060 0"></a-plane>
            <a-plane id="vr-hud-stress-fill" width="0.01" height="0.025" material="color:#10b981; opacity:0.92; ${commonMat}" position="-0.270 -0.060 0.001"></a-plane>
            <a-troika-text id="vr-hud-stress-text" value="Stress: 0%" max-width="0.62" font-size="0.026" color="#cbd5e1" position="-0.26 -0.110 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.9"></a-troika-text>
            <a-troika-text id="vr-hud-meta-text" value="" max-width="0.62" font-size="0.024" color="#94a3b8" position="-0.26 -0.155 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.86"></a-troika-text>
        `;

        root.appendChild(todoPanel);
        root.appendChild(levelPanel);
        this.buildVrHudControls(root);
        scene.appendChild(root);
        this._vrHud = root;

        setTimeout(() => this.layoutVrHud(), 0);
        try {
            if (!this._vrHudOnResize) {
                this._vrHudOnResize = () => this.layoutVrHud();
                window.addEventListener('resize', this._vrHudOnResize);
            }
        } catch (e) {}
    }

    createVrHud() {
        // Default: Lite HUD (stabiler beim XR-Start). Full HUD nur per URL-Flag.
        // Beispiel: ?fullHud=1
        try {
            const qs = String((window.location && window.location.search) || '');
            const forceFull = /[?&](fullHud|hudFull)=1(\b|&|$)/.test(qs);
            if (!forceFull) {
                this.createVrHudLite();
                return;
            }
        } catch (e) {
            this.createVrHudLite();
            return;
        }

        if (this._vrHud) return;
        const scene = document.querySelector('a-scene');
        const camera = (scene && scene.camera && scene.camera.el) ? scene.camera.el : (document.querySelector('[camera]') || document.querySelector('a-camera'));
        if (!camera) {
            // Kamera kann in A-Frame erst nach renderstart verfügbar sein
            setTimeout(() => this.createVrHud(), 200);
            return;
        }

        const root = document.createElement('a-entity');
        root.setAttribute('id', 'vr-hud');
        // Stabilized HUD: folgt der Kamera weich, bleibt lesbar
        root.setAttribute('position', '0 0 0');
        root.setAttribute('rotation', '0 0 0');
        const hudScale = this.getPreferredVrHudScale();
        this._vrHudScaleActive = hudScale;
        root.setAttribute('scale', `${hudScale} ${hudScale} ${hudScale}`);
        root.setAttribute('hud-stabilize', 'distance: 1.25; height: 0.12; followSpeed: 0.18; yawOnly: true');

        const commonMat = 'shader:flat; transparent:true; depthTest:false; depthWrite:false';

        // Stil an das normale Overlay angleichen (helles "HUD-Card" Design)
        // Hinweis: a-text/troika `color` ist nicht überall rgba-parsable -> Hex + material opacity.
        const hudText = '#e2e8f0';
        const hudSubText = '#cbd5e1';
        const hudMuted = '#94a3b8';
        const hudAccent = '#38bdf8';
        const cardBg = '#0b1220';
        const cardBorder = '#1f2a44';
        const cardShadow = '#000000';

        // Unten links: To-Do (größer, besseres Spacing)
        const todoCard = document.createElement('a-entity');
        todoCard.setAttribute('id', 'vr-hud-todo-panel');
        todoCard.setAttribute('position', '-0.58 -0.33 0.01');
        todoCard.innerHTML = `
            <!-- Schatten + Border + Card (helles UI wie das DOM-Overlay) -->
            <a-plane width="0.920" height="0.580" material="color:${cardShadow}; opacity:0.34; ${commonMat}" position="0.010 -0.010 -0.006"></a-plane>
            <a-plane width="0.900" height="0.560" material="color:${cardBorder}; opacity:0.48; ${commonMat}" position="0 0 -0.005"></a-plane>
            <a-plane width="0.890" height="0.550" material="color:${cardBg}; opacity:0.78; ${commonMat}" position="0 0 -0.004"></a-plane>
            <a-plane width="0.890" height="0.012" material="color:${hudAccent}; opacity:0.95; ${commonMat}" position="0 0.259 0.000"></a-plane>

            <a-troika-text value="📝 To-Do-Liste" max-width="0.82" font-size="0.038" color="${hudText}" position="-0.38 0.150 0.006" align="left" anchor="left" baseline="center"></a-troika-text>
            <a-troika-text id="vr-hud-subtitle-text" value="" max-width="0.84" font-size="0.024" color="${hudSubText}" position="-0.38 0.110 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.92"></a-troika-text>
            <a-troika-text id="vr-hud-metrics-text" value="" max-width="0.84" font-size="0.022" color="${hudMuted}" position="-0.38 0.080 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.90"></a-troika-text>
            <a-troika-text id="vr-hud-todo-text" value="" max-width="0.84" font-size="0.026" color="${hudMuted}" position="-0.38 0.040 0.006" align="left" anchor="left" baseline="top" line-height="1.30" fill-opacity="0.92"></a-troika-text>
        `;

        // Bottom-right: Focus / Level / Stress (größer, besseres Spacing)
        const levelCard = document.createElement('a-entity');
        levelCard.setAttribute('id', 'vr-hud-level-panel');
        levelCard.setAttribute('position', '0.58 -0.33 0.01');
        levelCard.innerHTML = `
            <a-plane width="0.720" height="0.580" material="color:${cardShadow}; opacity:0.34; ${commonMat}" position="0.010 -0.010 -0.006"></a-plane>
            <a-plane width="0.700" height="0.560" material="color:${cardBorder}; opacity:0.48; ${commonMat}" position="0 0 -0.005"></a-plane>
            <a-plane width="0.690" height="0.550" material="color:${cardBg}; opacity:0.78; ${commonMat}" position="0 0 -0.004"></a-plane>
            <a-plane width="0.690" height="0.012" material="color:${hudAccent}; opacity:0.95; ${commonMat}" position="0 0.259 0.000"></a-plane>

            <a-troika-text value="🎮 ADHS Sim" max-width="0.64" font-size="0.036" color="${hudText}" position="-0.26 0.155 0.006" align="left" anchor="left" baseline="center"></a-troika-text>
            
            <!-- Intensität-Sektion -->
            <a-troika-text value="Intensität:" max-width="0.64" font-size="0.026" color="${hudSubText}" position="-0.26 0.105 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.88"></a-troika-text>
            <a-plane id="vr-hud-level-chip-shadow" width="0.290" height="0.095" material="color:#000000; opacity:0.16; ${commonMat}" position="0.155 0.065 -0.003"></a-plane>
            <a-plane id="vr-hud-level-chip-border" width="0.286" height="0.091" material="color:#ffffff; opacity:0.72; ${commonMat}" position="0.152 0.067 -0.002"></a-plane>
            <a-plane id="vr-hud-level-chip" width="0.280" height="0.087" material="color:#e2e8f0; opacity:0.92; ${commonMat}" position="0.150 0.070 -0.001"></a-plane>
            <a-troika-text id="vr-hud-level-chip-text" value="Aus" max-width="0.26" font-size="0.032" color="#e2e8f0" position="0.150 0.070 0.006" align="center" anchor="center" baseline="center"></a-troika-text>

            <!-- Task-Info-Sektion -->
            <a-troika-text id="vr-hud-focus-text" value="" max-width="0.64" font-size="0.022" color="${hudMuted}" position="-0.26 0.010 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.85"></a-troika-text>
            <a-troika-text id="vr-hud-active-task-text" value="" max-width="0.64" font-size="0.026" color="${hudText}" position="-0.26 -0.028 0.006" align="left" anchor="left" baseline="center"></a-troika-text>

            <!-- Stress-Bar-Sektion -->
            <a-plane width="0.56" height="0.025" material="color:#0f172a; opacity:0.45; ${commonMat}" position="-0.01 -0.085 0"></a-plane>
            <a-plane id="vr-hud-stress-fill" width="0.01" height="0.025" material="color:#10b981; opacity:0.92; ${commonMat}" position="-0.270 -0.085 0.001"></a-plane>
            <a-troika-text id="vr-hud-stress-text" value="Stress: 0%" max-width="0.64" font-size="0.022" color="${hudMuted}" position="-0.26 -0.140 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.85"></a-troika-text>
            <a-troika-text id="vr-hud-meta-text" value="" max-width="0.64" font-size="0.020" color="${hudMuted}" position="-0.26 -0.185 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.75"></a-troika-text>
        `;

        // Top-left: Scene + message (entfernt auf User-Wunsch)
        const envCard = document.createElement('a-entity');
        envCard.setAttribute('id', 'vr-hud-env-panel');
        envCard.setAttribute('position', '-0.58 0.34 0.01');
        envCard.innerHTML = `
            <a-plane width="0.720" height="0.220" material="color:${cardShadow}; opacity:0.22; ${commonMat}" position="0.010 -0.010 -0.006"></a-plane>
            <a-plane width="0.700" height="0.200" material="color:${cardBorder}; opacity:0.62; ${commonMat}" position="0 0 -0.005"></a-plane>
            <a-plane width="0.690" height="0.190" material="color:${cardBg}; opacity:0.88; ${commonMat}" position="0 0 -0.004"></a-plane>
            <a-plane width="0.690" height="0.012" material="color:${hudAccent}; opacity:0.92; ${commonMat}" position="0 0.083 0.000"></a-plane>

            <a-circle id="vr-hud-env-dot" radius="0.016" segments="18" material="color:#94a3b8; opacity:0.95; ${commonMat}" position="-0.29 0.050 0"></a-circle>
            <a-troika-text id="vr-hud-env-title" value="" max-width="0.64" font-size="0.034" color="${hudText}" position="-0.26 0.060 0.006" align="left" anchor="left" baseline="center"></a-troika-text>
            <a-troika-text id="vr-hud-msg-text" value="" max-width="0.64" font-size="0.028" color="${hudMuted}" position="-0.26 0.020 0.006" align="left" anchor="left" baseline="center" fill-opacity="0.90"></a-troika-text>
        `;

        root.appendChild(todoCard);
        root.appendChild(levelCard);
        // Env/Room indicator not needed (user request): keep element out of HUD.
        // root.appendChild(envCard);
        this.buildVrHudControls(root);
        scene.appendChild(root);
        this._vrHud = root;

        // Dynamisches Layout: zuverlässig in den Ecken unabhängig von FOV/Aspect.
        setTimeout(() => this.layoutVrHud(), 0);
        try {
            if (!this._vrHudOnResize) {
                this._vrHudOnResize = () => this.layoutVrHud();
                window.addEventListener('resize', this._vrHudOnResize);
            }
        } catch (e) {}

        // Extra: Render-Layering erzwingen.
        // Bei transparenten Panels + Troika (Mesh entsteht async) kann die Sortierung sonst dazu führen,
        // dass das Panel den Text "übermalt". Deshalb mehrfach anwenden.
        const applyHudRenderOrdering = () => {
            try {
                if (!this._vrHud) return;
                const planes = this._vrHud.querySelectorAll('a-plane, a-circle');
                planes.forEach(el => {
                    if (!el || !el.object3D) return;
                    el.object3D.traverse((o) => {
                        o.renderOrder = 998;
                        // HUD-Flächen sollen niemals von Welt-Geometrie verdeckt werden.
                        const m = o.material;
                        if (m) {
                            m.depthTest = false;
                            m.depthWrite = false;
                            m.transparent = true;
                        }
                    });
                });

                const texts = this._vrHud.querySelectorAll('a-text, a-troika-text');
                texts.forEach(el => {
                    if (!el || !el.object3D) return;
                    el.object3D.traverse((o) => {
                        o.renderOrder = 1000;
                        // Troika erzeugt Meshes async; wenn depthTest an ist, kann Text "hinter" dem Schreibtisch verschwinden.
                        const m = o.material;
                        if (m) {
                            m.depthTest = false;
                            m.depthWrite = false;
                            m.transparent = true;
                        }
                    });
                });
            } catch (e) {}
        };
        setTimeout(applyHudRenderOrdering, 0);
        setTimeout(applyHudRenderOrdering, 250);
        setTimeout(applyHudRenderOrdering, 900);
        setTimeout(applyHudRenderOrdering, 1800);
    }

    removeVrHud() {
        if (!this._vrHud) return;
        try {
            if (this._vrHud.parentNode) this._vrHud.parentNode.removeChild(this._vrHud);
        } catch (e) {}
        this._vrHud = null;
        this._vrHudScaleActive = null;

        try {
            if (this._vrHudOnResize) {
                window.removeEventListener('resize', this._vrHudOnResize);
                this._vrHudOnResize = null;
            }
        } catch (e) {}
    }

    layoutVrHud() {
        if (!this._vrHud) return;

        const todoPanel = this._vrHud.querySelector('#vr-hud-todo-panel');
        const levelPanel = this._vrHud.querySelector('#vr-hud-level-panel');
        const controlsPanel = this._vrHud.querySelector('#vr-hud-controls-panel');
        // Env panel removed
        if (!todoPanel || !levelPanel) return;

        const scene = document.querySelector('a-scene');
        const cam = (scene && scene.camera) ? scene.camera : null;
        const THREERef = (typeof THREE !== 'undefined') ? THREE : null;
        if (!cam || !THREERef || !cam.isPerspectiveCamera) return;

        let z = 1.35;
        try {
            const cfg = this._vrHud.getAttribute && this._vrHud.getAttribute('hud-stabilize');
            if (cfg && typeof cfg === 'object' && cfg.distance) z = Number(cfg.distance) || z;
        } catch (e) {}
        const fovRad = THREERef.MathUtils.degToRad(cam.fov || 60);
        const halfH = Math.tan(fovRad / 2) * z;
        const aspect = cam.aspect || ((scene && scene.renderer && scene.renderer.domElement) ? (scene.renderer.domElement.clientWidth / scene.renderer.domElement.clientHeight) : 1);
        const halfW = halfH * (aspect || 1);
        const margin = 0.10;
        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

        // Panel sizes (in A-Frame units / meters)
        const scale = this._vrHudScaleActive || 1;
        const todoW = 0.86 * scale, todoH = 0.512 * scale;
        const levelW = 0.66 * scale, levelH = 0.492 * scale;
        const controlsW = 1.02 * scale, controlsH = 0.18 * scale;

        const xLeft = -halfW + margin;
        const xRight = halfW - margin;
        const yTop = halfH - margin;
        const yBottom = -halfH + margin;

        // Panels sollen näher beieinander bleiben, damit alles im Fokus bleibt.
        const liftBottomPanels = 0.12;
        const raiseHud = 0.32;
        const targetSpread = 0.55 * scale;

        const todoTargetX = -targetSpread;
        const levelTargetX = targetSpread;
        const todoX = clamp(todoTargetX, xLeft + todoW / 2, xRight - todoW / 2);
        const todoY = yBottom + todoH / 2 + liftBottomPanels + raiseHud;
        todoPanel.setAttribute('position', `${todoX.toFixed(3)} ${todoY.toFixed(3)} 0.01`);

        const levelX = clamp(levelTargetX, xLeft + levelW / 2, xRight - levelW / 2);
        const levelY = yBottom + levelH / 2 + liftBottomPanels + raiseHud;
        levelPanel.setAttribute('position', `${levelX.toFixed(3)} ${levelY.toFixed(3)} 0.01`);

        if (controlsPanel) {
            const controlsX = 0;
            const controlsY = yBottom + Math.max(levelH, todoH) + controlsH / 2 + 0.12 + liftBottomPanels + raiseHud;
            controlsPanel.setAttribute('position', `${controlsX.toFixed(3)} ${controlsY.toFixed(3)} 0.01`);
        }

        // (no env panel)
    }

    updateVrHud() {
        // Wenn wir in VR sind und im HUD-Modus laufen sollen, aber noch kein HUD existiert,
        // versuchen wir es einmal zu erzeugen (Timing/Browser-Quirks).
        if (!this._vrHud) {
            try {
                const scene = document.querySelector('a-scene');
                const inVr = !!(document.documentElement.classList.contains('in-vr') || (scene && scene.is && scene.is('vr-mode')));
                if (inVr && this._vrInterfaceMode === 'hud' && !this._vrHudPending) {
                    this._vrHudPending = true;
                    setTimeout(() => {
                        this._vrHudPending = false;
                        this.createVrHudLite();
                    }, 600);
                }
            } catch (e) {}
        }
        if (!this._vrHud) return;

        const clampHudText = (value, maxChars) => {
            const s = String(value || '');
            if (s.length <= maxChars) return s;
            return s.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
        };

        const clampHudMultiline = (value, maxLines, maxCharsPerLine) => {
            const raw = String(value || '').replace(/\r\n/g, '\n');
            const lines = raw.split('\n');
            const out = [];

            for (let i = 0; i < lines.length && out.length < maxLines; i++) {
                const line = lines[i].trimEnd();
                if (!line) {
                    out.push('');
                    continue;
                }
                out.push(clampHudText(line, maxCharsPerLine));
            }

            let joined = out.join('\n');
            if (lines.length > maxLines) joined = joined.trimEnd() + '…';
            return joined;
        };

        // Top-left env/room panel removed.

        const levelNames = ['Aus', 'Leicht', 'Mittel', 'Stark'];
        const label = (!this.active || this.paused) ? 'Aus' : (levelNames[this.distractionLevel] || 'Aus');
        const chipText = this._vrHud.querySelector('#vr-hud-level-chip-text');
        if (chipText) chipText.setAttribute('value', `${label}`);

        const chip = this._vrHud.querySelector('#vr-hud-level-chip');
        const chipBorder = this._vrHud.querySelector('#vr-hud-level-chip-border');
        if (chip) {
            // Farben ähnlich wie DOM-Chips (pastellig, aber gut lesbar in VR)
            const chipColors = {
                Aus: '#e2e8f0',
                Leicht: '#86efac',
                Mittel: '#fde047',
                Stark: '#fda4af'
            };
            const c = chipColors[label] || '#e2e8f0';
            try { chip.setAttribute('material', 'color', c); } catch (e) {}

            // Border/Typo leicht anpassen je nach Chip-Farbe (mehr Kontrast)
            try {
                if (chipBorder) chipBorder.setAttribute('material', 'color', '#ffffff');
            } catch (e) {}
            try {
                if (chipText) chipText.setAttribute('color', '#0f172a');
            } catch (e) {}
        }

        // VR-HUD Controls: Start/Stop Label & Farbe
        try {
            const toggleBtn = this._vrHud.querySelector('#vr-hud-btn-toggle');
            const toggleText = this._vrHud.querySelector('#vr-hud-btn-toggle-text');
            if (toggleBtn || toggleText) {
                const isRunning = !!(this.active && !this.paused);
                const labelTxt = isRunning ? 'Stop' : 'Start';
                const baseColor = isRunning ? '#ef4444' : '#22c55e';
                const hoverColor = isRunning ? '#f87171' : '#4ade80';
                if (toggleText) toggleText.setAttribute('value', labelTxt);
                if (toggleBtn) {
                    toggleBtn.setAttribute('material', 'color', baseColor);
                    toggleBtn.setAttribute('data-base-color', baseColor);
                    toggleBtn.setAttribute('data-hover-color', hoverColor);
                }
            }
        } catch (e) {}

        // Fokus/Task-Info rechts + Subtitle/Metrics im To-Do Panel
        const focusText = this._vrHud.querySelector('#vr-hud-focus-text');
        const activeTaskText = this._vrHud.querySelector('#vr-hud-active-task-text');
        const metaText = this._vrHud.querySelector('#vr-hud-meta-text');
        const subtitleText = this._vrHud.querySelector('#vr-hud-subtitle-text');
        const metricsText = this._vrHud.querySelector('#vr-hud-metrics-text');
        if (focusText || activeTaskText || subtitleText || metricsText) {
            const stateLabel = {
                idle: 'Warten',
                procrastinating: 'Prokrastination',
                working: 'Arbeit',
                hyperfocus: 'Hyperfokus'
            };
            const s = this.isHyperfocusActive() ? 'hyperfocus' : (this.taskState || 'idle');
            const isReentry = (s === 'working' && this.isReentryActive && this.isReentryActive());
            const focusLabel = isReentry ? 'Re-Entry' : (stateLabel[s] || '—');
            const stressPct = Math.round((this.stress || 0) * 100);
            const tb = (Date.now() < (this._timeBlindnessUntil || 0) && this._timeBlindnessMsg) ? ` · ${this._timeBlindnessMsg}` : '';
            const am = (Date.now() < (this._actionMsgUntil || 0) && this._actionMsg) ? ` · ${this._actionMsg}` : '';
            if (focusText) focusText.setAttribute('value', clampHudText(`Fokus: ${focusLabel} · Stress: ${stressPct}%${tb}${am}`, 84));
            if (subtitleText) subtitleText.setAttribute('value', clampHudText(`Fokus: ${focusLabel} · Stress: ${stressPct}%${tb}${am}`, 84));

            const t = this.getActiveTask ? this.getActiveTask() : null;
            const pct = t ? Math.round((t.progress || 0) * 100) : 0;
            const name = t ? (t.text || 'Aufgabe') : 'Aufgabe';
            if (activeTaskText) activeTaskText.setAttribute('value', clampHudText(`${pct}% · ${name}`, 54));

            // Metrics line (Browser-Overlay parity)
            const now = Date.now();
            const streak = Math.max(0, (this._refocusStreak || 0));
            const wastedMin = Math.max(0, Math.round(((this._totalTimeWasted || 0) / 60)));
            const spiral = Math.max(1, (this._giveInSpiralMultiplier || 1));
            const spiralTxt = spiral.toFixed(1);
            const shieldLeft = Math.max(0, Math.round(Math.max(0, (this._refocusShieldUntil || 0) - now) / 1000));
            const shield = shieldLeft > 0 ? ` · Shield ${shieldLeft}s` : '';
            if (metricsText) {
                metricsText.setAttribute('value', clampHudText(`Stress ${stressPct}% · Streak ${streak}x · Zeit ${wastedMin}m · Spirale ${spiralTxt}×${shield}`, 92));
            }
        }

        try {
            if (metaText) {
                const now = Date.now();
                const streak = Math.max(0, (this._refocusStreak || 0));
                const wastedMin = Math.max(0, Math.round(((this._totalTimeWasted || 0) / 60)));
                const spiral = Math.max(1, (this._giveInSpiralMultiplier || 1));
                const spiralTxt = spiral.toFixed(1);
                const shieldLeft = Math.max(0, Math.round(Math.max(0, (this._refocusShieldUntil || 0) - now) / 1000));
                const shield = shieldLeft > 0 ? ` · Shield ${shieldLeft}s` : '';
                metaText.setAttribute('value', clampHudText(`Streak: ${streak}x · Zeit: ${wastedMin}m · Spirale: ${spiralTxt}×${shield}`, 62));
            }
        } catch (e) {}

        // Stress Bar
        try {
            const fill = this._vrHud.querySelector('#vr-hud-stress-fill');
            const txt = this._vrHud.querySelector('#vr-hud-stress-text');
            const barW = 0.52;
            const stress = Math.max(0, Math.min(1, (this.stress || 0)));
            const w = Math.max(0.01, barW * stress);
            if (fill) {
                fill.setAttribute('width', w.toFixed(3));
                const x = (-barW / 2 + w / 2);
                fill.setAttribute('position', `${x.toFixed(3)} -0.120 0.001`);
                const c = (stress >= 0.66) ? '#ef4444' : (stress >= 0.33) ? '#f59e0b' : '#10b981';
                fill.setAttribute('material', 'color', c);

                // Critical highlight: subtle pulse (only the bar) when stress is high
                if (stress >= 0.66) {
                    const t = Date.now();
                    const pulse = 0.70 + 0.22 * (0.5 + 0.5 * Math.sin(t * 0.009));
                    fill.setAttribute('material', 'opacity', pulse);
                } else {
                    fill.setAttribute('material', 'opacity', 0.90);
                }
            }
            if (txt) txt.setAttribute('value', `Stress: ${Math.round(stress * 100)}%`);
        } catch (e) {}

        // To-Dos immer anzeigen (wie im Browser-Overlay)
        const showTodos = true;
        const todoPanel = this._vrHud.querySelector('#vr-hud-todo-panel');
        if (todoPanel) todoPanel.setAttribute('visible', true);

        const todoText = this._vrHud.querySelector('#vr-hud-todo-text');
        if (todoText) {
            const full = (this.tasks && this.tasks.length) ? this.tasks : (this.taskList || []).map(t => ({ text: t, progress: 0 }));

            // Desktop-ToDo zeigt im Focus-Mode nur die aktive Aufgabe -> VR soll gleich reagieren.
            const isFocusMode = (this.isFocusModeActive && this.isFocusModeActive());
            const list = isFocusMode
                ? [full[Math.max(0, Math.min(Number(this.activeTaskIndex) || 0, Math.max(0, full.length - 1)))] ]
                : full;

            const maxLines = this._vrHud.querySelector('#vr-hud-subtitle-text') ? 5 : 6;
            const safeActive = Math.max(0, Math.min(Number(this.activeTaskIndex) || 0, Math.max(0, list.length - 1)));
            let startIdx = 0;
            if (list.length > maxLines) {
                // Fenster so wählen, dass die aktive Aufgabe sicher sichtbar ist.
                startIdx = Math.min(Math.max(0, safeActive - 2), list.length - maxLines);
            }

            const windowItems = list.slice(startIdx, startIdx + maxLines);
            const remaining = Math.max(0, list.length - (startIdx + windowItems.length));

            let lines = windowItems.map((t, i) => {
                const realIdx = startIdx + i;
                const isActive = (!isFocusMode) ? (realIdx === safeActive) : true;
                const pct = Math.round((t && t.progress || 0) * 100);
                const name = (t && t.text) ? t.text : String(t);
                const isUrgent = /abgabe|hausarbeit|seminar|vortrag|feedback|meeting|präsentation|aufgabe|lernen|übung/i.test(name);
                const isWarn = /einkauf|milch|pizza|arzt|rechnung|kontostand/i.test(name);
                const icon = isUrgent ? '📚' : (isWarn ? '🛒' : '📝');
                const checkmark = (t && t.completed) ? '✓' : '○';
                return `${isActive ? '▶' : '•'} ${checkmark} ${icon} ${pct}% ${name}`;
            });

            // Wenn es mehr gibt, als in VR sichtbar ist, zeige einen Hinweis (damit "neue" Tasks nicht unsichtbar wirken).
            if (!isFocusMode && remaining > 0 && lines.length) {
                lines[lines.length - 1] = `… +${remaining} weitere`;
            }

            // Fallback, wenn keine Tasks vorhanden sind
            if (!lines.length) lines = ['(keine Tasks)'];

            // Verhindert, dass lange Aufgaben über die Card hinausragen
            todoText.setAttribute('value', clampHudMultiline(lines.join('\n'), maxLines, 34));
        }
    }

    // --- Debug: VR-HUD ohne Headset testen ---
    // Shift+V oder URL ?debugHud=1
    setVrHudDebugEnabled(enabled) {
        const on = !!enabled;
        this._vrHudDebug = on;
        if (on) {
            this.createVrHud();
            this.updateVrHud();
        } else {
            // Nur entfernen, wenn es wirklich unser Debug-Mode ist oder kein XR läuft.
            // (In echter XR-Session wird HUD ohnehin über enter/exit-vr gemanaged.)
            this.removeVrHud();
        }
    }

    toggleVrHudDebug() {
        this.setVrHudDebugEnabled(!this._vrHudDebug);
    }
        // --- ALLE SOUNDS  ---
        playSound_keyboard(ctx) {
            this.playSoundFile('CD_MACBOOK PRO LAPTOP KEYBOARD 01_10_08_13.wav', 1.2);
        }
        playSound_notification(ctx) {
            this.playSoundFile('MultimediaNotify_S011TE.579.wav', 0.8);
        }
        playSound_pencil(ctx) {
            this.playSoundFile('PencilWrite_S08OF.380.wav', 0.4);
        }
        playSound_whisper(ctx) {
            this.playSoundFile('SFX,Whispers,Layered,Verb.wav', 1.0);
        }
        playSound_shopping_cart(ctx) {
            this.playSoundFile('ShoppingCartTurn_S011IN.548.wav', 0.8);
        }
        playSound_footsteps(ctx) {
            this.playSoundFile('WalkWoodFloor_BWU.39.wav', 1.2);
        }
        playSound_wood_creaks(ctx) {
            this.playSoundFile('Wood_Creaks_01_BTM00499.wav', 0.6);
        }
        playSound_professor_mumble(ctx) {
            this.playSoundFile('indistinct-deep-male-mumble-14786.mp3', 1.0);
        }
        playSound_cell_phone_vibration(ctx) {
            this.playSoundFile('cell-phone-vibration-352298.mp3', 0.7);
        }
        playSound_cough(ctx) {
            this.playSoundFile('horrible-female-cough-66368.mp3', 1.0);
        }
        playSound_baby_crying(ctx) {
            this.playSoundFile('baby-crying-463213.mp3', 1.2);
        }
        playSound_computer_fan(ctx) {
            this.playSoundFile('computer-fan-75947.mp3', 1.5);
        }
        playSound_neighbors(ctx) {
            this.playSoundFile('annoying-neighbors-on-saturday-afternoon-23947.mp3', 1.5);
        }
        playSound_neighborhood_noise(ctx) {
            this.playSoundFile('neighborhood-noise-background-33025-320959.mp3', 1.5);
        }
        playSound_supermarket(ctx) {
            this.playSoundFile('supermarket-17823.mp3', 1.5);
        }

    // =============================================================
    // Umgebung / Szene
    // - Wir nutzen separate HTML-Seiten pro Szene (desk/hoersaal/supermarkt).
    // - Die Environment-Auswahl erfolgt daher simpel über die URL.
    // =============================================================
    detectEnvironment() {
        const url = window.location.href;
        if (url.includes('desk.html')) return 'desk';
        if (url.includes('hoersaal.html')) return 'hoersaal';
        if (url.includes('supermarkt.html')) return 'supermarkt';
        return 'desk'; // Fallback
    }

    // Kurzes Aufklärungs-Intro (einmalig), bevor die Szene startet.
    // Ziel: Empathie/Verständnis (ADHS != "nur Konzentration").
    installSceneIntroOnce() {
        if (this._sceneIntroInstalled) return;
        this._sceneIntroInstalled = true;

        const overlay = document.getElementById('ui-overlay');
        const scene = document.querySelector('a-scene');
        if (!overlay || !scene) return;
        if (document.getElementById('adhs-intro')) return;

        const env = this.environment || this.detectEnvironment();
        const key = `adhs_intro_seen_${env}`;
        try {
            if (window.localStorage && window.localStorage.getItem(key) === '1') return;
        } catch (e) {}

        const envTitle = {
            desk: 'Schreibtisch',
            hoersaal: 'Hörsaal',
            supermarkt: 'Supermarkt'
        }[env] || 'Simulation';

        const intro = document.createElement('div');
        intro.id = 'adhs-intro';
        intro.className = 'adhs-intro';
        intro.setAttribute('role', 'dialog');
        intro.setAttribute('aria-label', 'Kurzes Intro');

        intro.innerHTML = `
            <div class="adhs-intro__title">Kurzinfo – ${envTitle}</div>
            <div class="adhs-intro__text">
                Diese Simulation soll zeigen, dass ADHS mehr ist als „schlecht konzentrieren“:
                <ul>
                    <li><strong>Starten & Planen</strong> können schwer sein.</li>
                    <li><strong>Reizfilter</strong> kostet Energie – viele Reize gleichzeitig.</li>
                    <li><strong>Wiedereinstieg</strong> nach Unterbrechungen ist teuer.</li>
                    <li><strong>Zeitblindheit</strong> und <strong>Stress</strong> verstärken das.</li>
                </ul>
                <div class="adhs-intro__note">Hinweis: vereinfachte Erlebnissimulation – ADHS ist individuell.</div>
            </div>
            <div class="adhs-intro__actions">
                <button class="adhs-intro__btn" type="button" id="adhs-intro-ok">Verstanden</button>
            </div>
        `;

        // Insert at top so it is above the rest of the overlay.
        overlay.insertBefore(intro, overlay.firstChild);

        const close = () => {
            try { intro.classList.add('is-hiding'); } catch (e) {}
            try {
                if (window.localStorage) window.localStorage.setItem(key, '1');
            } catch (e) {}
            setTimeout(() => {
                try { if (intro.parentNode) intro.parentNode.removeChild(intro); } catch (e) {}
            }, 220);
        };

        const okBtn = intro.querySelector('#adhs-intro-ok');
        if (okBtn) okBtn.addEventListener('click', close);

        // Auto-hide after a short time (still marks as seen).
        setTimeout(() => {
            if (!document.getElementById('adhs-intro')) return;
            close();
        }, 9000);

        // In VR: hide immediately (overlay feels "UI-heavy" in-headset).
        try {
            scene.addEventListener('enter-vr', close, { once: true });
        } catch (e) {}
    }

    // =============================================================
    // Simulation Lifecycle
    // start(level)
    // - level 0 = Aus
    // - level 1..3 = steigende Reiz-Dichte (Intervalle/Chancen)
    // - Initialisiert Intervalle (Visual/Audio/Notifications) + Task-Ticking
    // - Entsperrt Audio (Autoplay-Policy: nur durch User-Geste)
    // =============================================================
    start(level = 0) {
        const clampedLevel = Math.max(0, Math.min(3, Number(level) || 0));

        // Wenn eine neue Session gestartet wird, darf keine alte Summary "stehen bleiben".
        // (Auto-Hide Timings können sonst überlappen, v.a. beim schnellen Neustart.)
        try {
            const domSummary = document.getElementById('adhs-session-summary');
            if (domSummary && domSummary.parentNode) domSummary.parentNode.removeChild(domSummary);
        } catch (e) {}
        try {
            const vrSummary = document.getElementById('adhs-vr-session-summary');
            if (vrSummary && vrSummary.parentNode) vrSummary.parentNode.removeChild(vrSummary);
        } catch (e) {}

        // Immer erst sauber aufräumen
        this.stop({ silent: true });

        // Level 0 bedeutet: Aus (kein "active" Zustand ohne Effekte)
        if (clampedLevel === 0) {
            this.distractionLevel = 0;
            this.updateStatusDisplay();
            this.updateVrHud();
            return;
        }

        this.active = true;
        this.paused = false;
        this.distractionLevel = clampedLevel;

        // Session-Metriken (für Summary am Ende)
        try {
            this._sessionStartedAt = Date.now();
            this._sessionLevel = clampedLevel;
            this._sessionEnv = this.environment || this.detectEnvironment();
            this._sessionInitialTaskCount = (this.tasks || []).length;
            this._sessionInitialDoneCount = (this.tasks || []).filter(t => (t && (t.progress || 0) >= 1)).length;
            this._totalTimeWasted = 0;
            this._totalGiveIns = 0;
            this._totalRefocus = 0;
            this._stressPeak = Math.max(0, Number(this.stress) || 0);
        } catch (e) {}

        // VR HUD Listener einmalig installieren
        this.installVrHudOnce();

        // Audio nach User-Gesture entsperren (Start() wird per Button/Klick ausgelöst)
        this.unlockAudio();

        const levelName = ['none', 'low', 'medium', 'high'][clampedLevel];
        const baseConfig = this.config[levelName];
        // Nicht mutieren (config wird unten ggf. desk-spezifisch angepasst)
        let config = { ...baseConfig };

        // Option B: Umgebung bleibt charakteristisch, aber Intensität (1/2/3) soll überall ähnlich deutlich wirken.
        if (clampedLevel > 0) {
            const env = this.environment;
            const multByEnv = {
                // Desk: etwas mehr "kleines Chaos" bei Mittel/Stark (ohne aggressive Kopfbewegung)
                desk: {
                    visual: [1.0, 0.92, 0.82, 0.70],
                    audio: [1.0, 0.92, 0.82, 0.70],
                    notif: [1.0, 0.96, 0.90, 0.86],
                    minVisual: 1800,
                    minAudio: 3200,
                    minNotif: 8000
                },
                // Hörsaal: mehr Audio/Social-Overload bei hoch, aber nicht nur über Lautstärke, sondern über Dichte.
                hoersaal: {
                    visual: [1.0, 0.95, 0.86, 0.76],
                    audio: [1.0, 0.92, 0.82, 0.72],
                    notif: [1.0, 0.95, 0.86, 0.78],
                    minVisual: 2000,
                    minAudio: 2800,
                    minNotif: 8500
                },
                // Supermarkt: hohe Intensität fühlt sich wie "Crowd + Noise" an.
                supermarkt: {
                    visual: [1.0, 0.95, 0.85, 0.75],
                    audio: [1.0, 0.92, 0.80, 0.70],
                    notif: [1.0, 0.96, 0.88, 0.80],
                    minVisual: 2100,
                    minAudio: 2600,
                    minNotif: 9000
                }
            };

            const t = multByEnv[env] || multByEnv.desk;
            if (typeof config.visualFrequency === 'number') {
                config.visualFrequency = Math.max(t.minVisual, Math.round(config.visualFrequency * (t.visual[clampedLevel] || 1.0)));
            }
            if (typeof config.audioFrequency === 'number') {
                config.audioFrequency = Math.max(t.minAudio, Math.round(config.audioFrequency * (t.audio[clampedLevel] || 1.0)));
            }
            if (typeof config.notificationFrequency === 'number') {
                config.notificationFrequency = Math.max(t.minNotif, Math.round(config.notificationFrequency * (t.notif[clampedLevel] || 1.0)));
            }
        }
        
        console.log(`🎮 ADHS Simulation läuft - Level: ${levelName}`);
        
        if (clampedLevel > 0) {
            // Aufgabenpanel anzeigen
            this.showTaskPanel();

            // Aufgabe-vs-Reiz Simulation
            this.setTaskState('idle', 0);
            this.startTaskTicking();

            // Visuelle Ablenkungen spawnen (Lichter, Popups, etc.)
            this.visualInterval = setInterval(() => {
                this.spawnVisualDistraction();
            }, config.visualFrequency);
            
            // Audio Ablenkungen (Piepen, Klicken, Vibrieren)
            this.audioInterval = setInterval(() => {
                this.playAudioDistraction();
            }, config.audioFrequency);
            
            // Smartphone/Notifications: nur eine Quelle je Umgebung, sonst spamt es (Popup + Visual + Start-Boost).
            this._phonePopupMinMs = typeof config.notificationFrequency === 'number' ? config.notificationFrequency : (this._phonePopupMinMs || 6500);
            // "Task-Injection" über Handy bewusst seltener als die Notification selbst.
            // (Sonst wächst die To-Do-Liste unrealistisch schnell und wirkt repetitiv.)
            try {
                const nf = Number(config.notificationFrequency) || 12000;
                // User-Feedback: Tasks sollen sich wieder zuverlässig "vermehren".
                // => weniger aggressiv drosseln, aber trotzdem nicht bei jeder Notification eskalieren.
                this._phoneTodoMinMs = Math.max(10000, Math.round(nf * 1.35));
            } catch (e) {}
            this.notificationInterval = setInterval(() => {
                // Alle Umgebungen nutzen Phone-Notifications.
                // Desk zeigt sie auf dem Tisch-Handy (siehe createLargePopup),
                // Hörsaal/Supermarkt als großes Popup.
                this.createLargePopup();
            }, config.notificationFrequency);
            
            // Bewegte Objekte für extra Chaos
            this.startMovingObjects(config.movementSpeed);
            
            // Professor redet im Hörsaal (wie bei Sims - klingt wie reden aber ist unverständlich)
            if (this.environment === 'hoersaal') {
                this.startProfessorTalking();
            }
            // Nachbarschaftsgeräusch im Hintergrund für desk.html
            if (this.environment === 'desk') {
                this.startNeighborhoodNoise();
            }
        }

        // Supermarkt-Ambience läuft bewusst unabhängig von der Intensität,
        // sobald die Simulation aktiv ist (User-Wunsch: "die ganze Zeit").
        if (this.environment === 'supermarkt') {
            this.startSupermarketAmbience();
        }
        
        // Anzeige updaten
        this.updateStatusDisplay();

        this.updateVrHud();
    }

    // stop()
    // - räumt Intervalle/Audio auf
    // - entfernt visuelle Ablenkungen + Panels
    // - optional: zeigt eine kurze Summary der Session (Zeitverlust/Stress)
    stop(opts = {}) {
        const options = (typeof opts === 'object' && opts) ? opts : { silent: !!opts };
        const wasActive = !!this.active;
        const hadLevel = Number(this.distractionLevel) || 0;
        const shouldShowSummary = !options.silent && wasActive && hadLevel > 0 && !!this._sessionStartedAt;

        this.active = false;
        
        // Timer stoppen
        if (this.visualInterval) clearInterval(this.visualInterval);
        if (this.audioInterval) clearInterval(this.audioInterval);
        if (this.notificationInterval) clearInterval(this.notificationInterval);
        
        // Professor-Audio stoppen
        this.stopProfessorTalking();
        
        // Aufräumen
        this.clearAllDistractions();
        this.removeTaskPanel();
        this.stopTaskTicking();
        this.taskState = 'idle';
        this._hyperfocusUntil = 0;
        // Nachbarschaftsgeräusch stoppen
        this.stopNeighborhoodNoise();

        // Supermarkt-Ambience stoppen
        this.stopSupermarketAmbience();
        
        console.log('🛑 Simulation gestoppt - endlich Ruhe!');

        // Summary am Ende (Desktop Overlay oder VR-Panel)
        try {
            if (shouldShowSummary) {
                const summary = this.buildSessionSummary();
                this.showSessionSummary(summary);
            }
        } catch (e) {}

        // Session resetten (verhindert doppelte Summary bei erneutem Stop)
        try {
            if (shouldShowSummary) {
                this._sessionStartedAt = 0;
            }
        } catch (e) {}

        this.updateVrHud();
    }

    buildSessionSummary() {
        const now = Date.now();
        const startedAt = Number(this._sessionStartedAt) || 0;
        const durMs = startedAt ? Math.max(0, now - startedAt) : 0;
        const durMin = Math.max(0, Math.round(durMs / 60000));
        const wastedMin = Math.max(0, Math.round((Number(this._totalTimeWasted) || 0) / 60));

        const tasks = Array.isArray(this.tasks) ? this.tasks : [];
        const done = tasks.filter(t => (t && (t.progress || 0) >= 1)).length;
        const initialDone = Number(this._sessionInitialDoneCount) || 0;
        const doneThisSession = Math.max(0, done - initialDone);

        const env = this._sessionEnv || this.environment || 'desk';
        const envLabel = { desk: 'Schreibtisch', hoersaal: 'Hörsaal', supermarkt: 'Supermarkt' }[env] || env;

        const level = Number(this._sessionLevel || this.distractionLevel) || 0;
        const levelLabel = ['Aus', 'Leicht', 'Mittel', 'Stark'][level] || String(level);

        const stressNow = Math.max(0, Math.round((Number(this.stress) || 0) * 100));
        const stressPeak = Math.max(0, Math.round((Number(this._stressPeak) || Number(this.stress) || 0) * 100));

        return {
            title: 'Session Summary',
            env: envLabel,
            level: levelLabel,
            durationMin: durMin,
            wastedMin,
            tasksDoneThisSession: doneThisSession,
            tasksDoneTotal: done,
            tasksTotal: tasks.length,
            refocus: Number(this._totalRefocus) || 0,
            giveIns: Number(this._totalGiveIns) || 0,
            refocusStreak: Number(this._refocusStreak) || 0,
            stressNow,
            stressPeak
        };
    }

    showSessionSummary(summary, opts = {}) {
        const scene = document.querySelector('a-scene');
        const inVr = !!(document.documentElement.classList.contains('in-vr') || (scene && scene.is && scene.is('vr-mode')));
        const autoHideMs = Math.max(3000, Math.min(20000, Number(opts.autoHideMs) || 12000));

        if (inVr) {
            this.showVrSessionSummary(summary, { autoHideMs: Math.min(9000, autoHideMs) });
            return;
        }

        const overlay = document.getElementById('ui-overlay') || document.body;
        if (!overlay) return;

        try {
            const old = document.getElementById('adhs-session-summary');
            if (old && old.parentNode) old.parentNode.removeChild(old);
        } catch (e) {}

        const card = document.createElement('div');
        card.id = 'adhs-session-summary';
        card.className = 'hud-card adhs-summary';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-label', 'Session Summary');

        const lines = [
            `${summary.env} • Level: ${summary.level}`,
            `Dauer: ${summary.durationMin} min`,
            `Zeit verloren: ${summary.wastedMin} min`,
            `Refocus: ${summary.refocus} (Streak: ${summary.refocusStreak || 0})`,
            `Nachgegeben: ${summary.giveIns}`,
            `Tasks erledigt: +${summary.tasksDoneThisSession} (gesamt ${summary.tasksDoneTotal}/${summary.tasksTotal})`,
            `Stress: ${summary.stressNow}% (Peak ${summary.stressPeak}%)`
        ];

        card.innerHTML = `
            <div class="adhs-summary__head">
                <div class="adhs-summary__title">${summary.title}</div>
                <button class="adhs-summary__close" type="button" aria-label="Schließen">×</button>
            </div>
            <div class="adhs-summary__body">
                ${lines.map(l => `<div class="adhs-summary__line">${l}</div>`).join('')}
            </div>
            <div class="adhs-summary__hint">Tipp: Für Vergleiche einfach nochmal starten und stoppen.</div>
        `;

        overlay.appendChild(card);

        const close = () => {
            try { card.classList.add('is-hiding'); } catch (e) {}
            setTimeout(() => {
                try { if (card.parentNode) card.parentNode.removeChild(card); } catch (e) {}
            }, 220);
        };

        const closeBtn = card.querySelector('.adhs-summary__close');
        if (closeBtn) closeBtn.addEventListener('click', close);

        const onKey = (ev) => {
            const k = ev && (ev.key || ev.code);
            if (k === 'Escape') {
                try { ev.preventDefault(); } catch (e) {}
                close();
                try { window.removeEventListener('keydown', onKey, true); } catch (e) {}
            }
        };
        try { window.addEventListener('keydown', onKey, true); } catch (e) {}

        setTimeout(() => {
            if (!document.getElementById('adhs-session-summary')) return;
            close();
            try { window.removeEventListener('keydown', onKey, true); } catch (e) {}
        }, autoHideMs);
    }

    showVrSessionSummary(summary, opts = {}) {
        try {
            const camera = document.querySelector('a-camera') || document.querySelector('[camera]');
            if (!camera) return;

            const autoHideMs = Math.max(2500, Math.min(12000, Number(opts.autoHideMs) || 7000));

            // Remove old
            try {
                const old = document.getElementById('adhs-vr-session-summary');
                if (old && old.parentNode) old.parentNode.removeChild(old);
            } catch (e) {}

            const panel = document.createElement('a-entity');
            panel.setAttribute('id', 'adhs-vr-session-summary');
            panel.setAttribute('position', '0 0 -0.75');
            panel.setAttribute('scale', '1 1 1');

            const bg = document.createElement('a-plane');
            bg.setAttribute('width', '1.15');
            bg.setAttribute('height', '0.56');
            bg.setAttribute('position', '0 0 0');
            bg.setAttribute('material', 'shader:flat; transparent:true; opacity:0.80; color:#0b1220; depthTest:false; depthWrite:false');

            const title = document.createElement('a-troika-text');
            title.setAttribute('value', summary.title);
            title.setAttribute('max-width', '1.05');
            title.setAttribute('font-size', '0.055');
            title.setAttribute('color', '#e2e8f0');
            title.setAttribute('position', '-0.52 0.20 0.01');
            title.setAttribute('align', 'left');
            title.setAttribute('anchor', 'left');
            title.setAttribute('baseline', 'center');

            const body = document.createElement('a-troika-text');
            const txt = [
                `${summary.env} • Level: ${summary.level}`,
                `Dauer: ${summary.durationMin} min`,
                `Zeit verloren: ${summary.wastedMin} min`,
                `Refocus: ${summary.refocus} (Streak ${summary.refocusStreak || 0})`,
                `Nachgegeben: ${summary.giveIns}`,
                `Tasks: +${summary.tasksDoneThisSession} (gesamt ${summary.tasksDoneTotal}/${summary.tasksTotal})`,
                `Stress: ${summary.stressNow}% (Peak ${summary.stressPeak}%)`
            ].join('\n');
            body.setAttribute('value', txt);
            body.setAttribute('max-width', '1.05');
            body.setAttribute('font-size', '0.040');
            body.setAttribute('line-height', '1.35');
            body.setAttribute('color', '#cbd5e1');
            body.setAttribute('position', '-0.52 0.11 0.01');
            body.setAttribute('align', 'left');
            body.setAttribute('anchor', 'left');
            body.setAttribute('baseline', 'top');

            panel.appendChild(bg);
            panel.appendChild(title);
            panel.appendChild(body);
            camera.appendChild(panel);

            // Ensure visibility (Troika mesh async)
            const applyOrdering = () => {
                try {
                    panel.object3D.traverse((o) => {
                        o.renderOrder = 1200;
                        if (o.material) {
                            o.material.depthTest = false;
                            o.material.depthWrite = false;
                            o.material.transparent = true;
                        }
                    });
                } catch (e) {}
            };
            setTimeout(applyOrdering, 0);
            setTimeout(applyOrdering, 250);
            setTimeout(applyOrdering, 900);

            setTimeout(() => {
                try { if (panel && panel.parentNode) panel.parentNode.removeChild(panel); } catch (e) {}
            }, autoHideMs);
        } catch (e) {
            // ignorieren
        }
    }

    getAudioContext() {
        if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
        try {
            if (!this._audioCtx || this._audioCtx.state === 'closed') {
                this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
        } catch (e) {
            // Manche Browser werfen ohne User-Gesture (Autoplay Policy). Dann trotzdem ohne Audio weitermachen.
            this._audioCtx = null;
            return null;
        }

        try {
            if (this._audioCtx && this._audioCtx.state === 'suspended') {
                this._audioCtx.resume().catch(() => {});
            }
        } catch (e) {
            // ignorieren
        }
        return this._audioCtx || null;
    }

    unlockAudio() {
        const ctx = this.getAudioContext();
        if (!ctx || this._audioUnlocked) return;
        try {
            const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.start(0);
        } catch (e) {
            // ignorieren
        }
        this._audioUnlocked = true;
    }

    // VR-Komfort: Statt Rig zu drehen (unangenehm), zeigen wir einen Blickhinweis im Sichtfeld.
    // Dieser Hinweis simuliert den "Fokus-Shift" ohne den Nutzer physisch zu drehen.
    createGazeCue(targetX, targetY, targetZ, durationMs = 1200) {
        const camera = document.querySelector('a-camera') || document.querySelector('[camera]');
        const rig = document.querySelector('#rig');
        if (!camera || !rig) return;

        // Don't spam the user's view: keep a short cooldown and keep only one cue at a time.
        const now = Date.now();
        if (this._lastGazeCueAt && (now - this._lastGazeCueAt) < 650) return;
        this._lastGazeCueAt = now;

        // Neutral, weniger "spielerisch": kein Pfeil-Overlay, sondern kurzer Text-Hinweis im HUD.

        const rigPos = rig.getAttribute('position') || { x: 0, y: 0, z: 0 };
        const dx = targetX - rigPos.x;
        const dy = targetY - rigPos.y;
        const dz = targetZ - rigPos.z;

        // Richtung grob bestimmen (links/rechts/hoch/runter)
        let dir = 'rechts';
        if (Math.abs(dx) >= Math.abs(dy)) {
            dir = dx >= 0 ? 'rechts' : 'links';
        } else {
            // In A-Frame ist "hoch" typischerweise +Y
            dir = dy >= 0 ? 'oben' : 'unten';
        }

        const total = Math.max(650, Math.min(2000, durationMs));
        this._gazeCueMsg = `Blick: ${dir}`;
        this._gazeCueUntil = Date.now() + total;
        this.updateVrHud();
    }

    // Auffälliger, kurzer "Spotlight" am eigentlichen Refocus-Ziel (funktioniert in Desktop + VR)
    createRefocusSpotlight(targetX, targetY, targetZ, durationMs = 1500) {
        try {
            const scene = document.querySelector('a-scene');
            if (!scene) return;

            const now = Date.now();
            if (this._lastRefocusSpotlightAt && (now - this._lastRefocusSpotlightAt) < 900) return;
            this._lastRefocusSpotlightAt = now;

            // Remove previous instance
            try {
                if (this._refocusSpotlightEl && this._refocusSpotlightEl.parentNode) {
                    this._refocusSpotlightEl.parentNode.removeChild(this._refocusSpotlightEl);
                }
            } catch (e) {}

            const container = document.createElement('a-entity');
            container.setAttribute('id', 'adhs-refocus-spotlight');
            container.setAttribute('position', `${targetX} ${targetY} ${targetZ}`);

            const commonMat = 'shader: flat; transparent: true; side: double; depthTest: false; depthWrite: false';
            const glowColor = '#ffe066';

            // Billboarded glow (always faces camera)
            const billboard = document.createElement('a-entity');
            billboard.setAttribute('id', 'adhs-refocus-spotlight-billboard');
            billboard.setAttribute('position', '0 0 0');

            const glowDisc = document.createElement('a-circle');
            glowDisc.setAttribute('radius', '0.18');
            glowDisc.setAttribute('material', `${commonMat}; color: ${glowColor}; opacity: 0.0`);
            glowDisc.setAttribute('segments', '48');
            billboard.appendChild(glowDisc);

            const glowRing = document.createElement('a-ring');
            glowRing.setAttribute('radius-inner', '0.18');
            glowRing.setAttribute('radius-outer', '0.245');
            glowRing.setAttribute('material', `${commonMat}; color: ${glowColor}; opacity: 0.0`);
            glowRing.setAttribute('segments-theta', '64');
            billboard.appendChild(glowRing);

            // Vertikaler "Beam", damit es wie ein Scheinwerfer wirkt
            const beam = document.createElement('a-cylinder');
            beam.setAttribute('position', '0 0.55 0');
            beam.setAttribute('height', '1.10');
            beam.setAttribute('radius', '0.10');
            beam.setAttribute('material', `${commonMat}; color: ${glowColor}; opacity: 0.0`);
            beam.setAttribute('segments-radial', '24');

            // Optional: echtes Licht (hilft nur, wenn die Szene "lit" Materialien nutzt)
            const light = document.createElement('a-light');
            light.setAttribute('type', 'point');
            light.setAttribute('color', glowColor);
            light.setAttribute('intensity', '0');
            light.setAttribute('distance', '3.2');
            light.setAttribute('decay', '2');
            light.setAttribute('position', '0 0.55 0');

            container.appendChild(billboard);
            container.appendChild(beam);
            container.appendChild(light);

            scene.appendChild(container);
            this._refocusSpotlightEl = container;

            // Möglichst sichtbar machen (auch durch Geometrie) und über dem meisten Rendering
            try {
                const applyOrdering = () => {
                    if (!container || !container.object3D) return;
                    container.object3D.traverse((o) => {
                        o.renderOrder = 1200;
                        if (o.material) {
                            o.material.depthTest = false;
                            o.material.depthWrite = false;
                            o.material.transparent = true;
                        }
                    });
                };
                setTimeout(applyOrdering, 0);
                setTimeout(applyOrdering, 250);
                setTimeout(applyOrdering, 900);
            } catch (e) {}

            const camera = document.querySelector('a-camera') || document.querySelector('[camera]');
            const start = Date.now();
            const total = Math.max(900, Math.min(2400, durationMs || 1500));
            const fadeIn = 180;
            const fadeOut = 520;
            const hold = Math.max(0, total - fadeIn - fadeOut);

            let lastAlpha = -1;
            let lastBeamAlpha = -1;
            let lastLight = -1;
            let lastScale = -1;

            const tick = setInterval(() => {
                const elapsed = Date.now() - start;
                if (elapsed >= total + 60) {
                    clearInterval(tick);
                    try { if (container && container.parentNode) container.parentNode.removeChild(container); } catch (e) {}
                    return;
                }

                // Alpha envelope
                let a = 1;
                if (elapsed < fadeIn) a = elapsed / fadeIn;
                else if (elapsed < (fadeIn + hold)) a = 1;
                else a = 1 - Math.min(1, (elapsed - fadeIn - hold) / fadeOut);

                // Kleiner "Pulse", damit es mehr auffällt
                const pulseT = Math.min(1, elapsed / 650);
                const pulse = 1 + 0.38 * Math.sin(pulseT * Math.PI);

                const ringAlpha = 0.92 * a;
                const discAlpha = 0.22 * a;
                const beamAlpha = 0.18 * a;
                const intensity = 2.2 * a;
                const scale = pulse;

                if (camera && camera.object3D && billboard && billboard.object3D && typeof THREE !== 'undefined') {
                    try {
                        const v = new THREE.Vector3();
                        camera.object3D.getWorldPosition(v);
                        billboard.object3D.lookAt(v);
                    } catch (e) {}
                }

                // DOM nicht unnötig stressen: nur updaten, wenn sich Werte genug geändert haben
                if (Math.abs(ringAlpha - lastAlpha) > 0.02) {
                    glowRing.setAttribute('material', `${commonMat}; color: ${glowColor}; opacity: ${ringAlpha.toFixed(3)}`);
                    glowDisc.setAttribute('material', `${commonMat}; color: ${glowColor}; opacity: ${discAlpha.toFixed(3)}`);
                    lastAlpha = ringAlpha;
                }
                if (Math.abs(beamAlpha - lastBeamAlpha) > 0.02) {
                    beam.setAttribute('material', `${commonMat}; color: ${glowColor}; opacity: ${beamAlpha.toFixed(3)}`);
                    lastBeamAlpha = beamAlpha;
                }
                if (Math.abs(intensity - lastLight) > 0.08) {
                    light.setAttribute('intensity', intensity.toFixed(2));
                    lastLight = intensity;
                }
                if (Math.abs(scale - lastScale) > 0.03) {
                    billboard.setAttribute('scale', `${scale.toFixed(3)} ${scale.toFixed(3)} ${scale.toFixed(3)}`);
                    lastScale = scale;
                }
            }, 30);
        } catch (e) {
            // ignorieren
        }
    }

    // --- Hintergrundgeräusch für desk.html ---
    startNeighborhoodNoise() {
        this.stopNeighborhoodNoise();

        // WebAudio bevorzugen, damit wir es räumlich platzieren können.
        // (Fallback ist normales <audio> ohne räumliche Positionierung.)
        const ctx = this.getAudioContext();
        const filename = 'neighborhood-noise-background-33025-320959.mp3';
        const path = `Assets/Textures/sounds/${filename}`;

        if (ctx) {
            // Fixe "draußen/Nachbar" Position: links-hinten relativ zum User.
            const pos = this.getWorldPosFromCameraOffset({ x: -1.6, y: 0.10, z: 1.25 });
            const out = this.createSpatialOutput(ctx, { volume: 0.10, pan: -0.55, pos });

            const cached = this._audioBufferCache.get(filename);
            const startLoop = (audioBuffer) => {
                if (!audioBuffer) return;
                if (!this.active) return;

                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.loop = true;
                source.connect(out);
                source.start(ctx.currentTime);
                this._neighborhoodNoiseSource = source;

                // Keep listener synced while the loop is playing.
                this._neighborhoodNoiseListenerInterval = setInterval(() => {
                    this.updateListenerFromCamera(ctx);
                }, 200);
            };

            if (cached) {
                startLoop(cached);
                return;
            }

            fetch(path)
                .then(r => r.arrayBuffer())
                .then(ab => ctx.decodeAudioData(ab))
                .then(audioBuffer => {
                    this._audioBufferCache.set(filename, audioBuffer);
                    startLoop(audioBuffer);
                })
                .catch(() => {
                    // Fallback to HTMLAudio if fetch/decode fails.
                    const a = new Audio(path);
                    a.loop = true;
                    a.volume = 0.12;
                    this.neighborhoodNoiseAudio = a;
                    a.play().catch(() => {});
                });
            return;
        }

        // Fallback: HTMLAudio (non-spatial)
        const a = new Audio(path);
        a.loop = true;
        a.volume = 0.12; // Sehr dezent
        this.neighborhoodNoiseAudio = a;
        a.play().catch(() => {});
    }
    stopNeighborhoodNoise() {
        if (this._neighborhoodNoiseListenerInterval) {
            clearInterval(this._neighborhoodNoiseListenerInterval);
            this._neighborhoodNoiseListenerInterval = null;
        }

        if (this._neighborhoodNoiseSource) {
            try { this._neighborhoodNoiseSource.stop(); } catch (e) {}
            try { this._neighborhoodNoiseSource.disconnect(); } catch (e) {}
            this._neighborhoodNoiseSource = null;
        }

        if (this.neighborhoodNoiseAudio) {
            try {
                this.neighborhoodNoiseAudio.pause();
                this.neighborhoodNoiseAudio.currentTime = 0;
            } catch(e) {}
            this.neighborhoodNoiseAudio = null;
        }
        }

    // =============================================================
    // Supermarkt-Ambience (Loop)
    // Ziel: ein durchgehender Hintergrundteppich, der „immer da“ ist,
    // ähnlich wie der Prof-Sound im Hörsaal.
    // Umsetzung:
    // 1) Wenn in der Szene vorhanden: A-Frame <a-entity sound> nutzen
    // 2) Fallback: WebAudio Loop
    // 3) Letzter Fallback: HTMLAudio
    // =============================================================
    startSupermarketAmbience() {
        this.stopSupermarketAmbience();

        const filename = 'supermarket-17823.mp3';
        const path = `Assets/Textures/sounds/${filename}`;
        const targetVolume = 0.18; // "wie beim Prof" (ähnliche gefühlte Lautstärke)

        // 1) Prefer A-Frame sound component if present (avoids double audio pipelines)
        try {
            const el = document.querySelector('#ambience-supermarket');
            if (el) {
                // Component may not be ready immediately after start()
                const tryPlay = () => {
                    if (!this.active) return true;
                    try {
                        el.setAttribute('sound', 'loop', true);
                        el.setAttribute('sound', 'volume', targetVolume);
                        if (el.components && el.components.sound && typeof el.components.sound.playSound === 'function') {
                            el.components.sound.playSound();
                            this._supermarketAmbienceEl = el;
                            return true;
                        }
                    } catch (e) {}
                    return false;
                };

                if (tryPlay()) return;

                // retry a few times (A-Frame init timing)
                let tries = 0;
                this._supermarketAmbienceRetryInterval = setInterval(() => {
                    tries++;
                    if (tryPlay() || tries >= 25) {
                        try { clearInterval(this._supermarketAmbienceRetryInterval); } catch (e) {}
                        this._supermarketAmbienceRetryInterval = null;
                    }
                }, 200);
                return;
            }
        } catch (e) {}

        // 2) WebAudio fallback (non-spatial stereo, consistent loop)
        const ctx = this.getAudioContext();
        if (ctx) {
            const out = this.createSpatialOutput(ctx, { volume: 1.0, pan: 0, pos: null });
            const gain = ctx.createGain();
            gain.gain.value = targetVolume;
            gain.connect(out);
            this._supermarketAmbienceGain = gain;

            const cached = this._audioBufferCache.get(filename);
            const startLoop = (audioBuffer) => {
                if (!audioBuffer) return;
                if (!this.active) return;

                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.loop = true;
                source.connect(gain);
                source.start(ctx.currentTime);
                this._supermarketAmbienceSource = source;
            };

            if (cached) {
                startLoop(cached);
                return;
            }

            fetch(path)
                .then(r => r.arrayBuffer())
                .then(ab => ctx.decodeAudioData(ab))
                .then(audioBuffer => {
                    this._audioBufferCache.set(filename, audioBuffer);
                    startLoop(audioBuffer);
                })
                .catch(() => {
                    // 3) HTMLAudio fallback
                    const a = new Audio(path);
                    a.loop = true;
                    a.volume = targetVolume;
                    this.supermarketAmbienceAudio = a;
                    a.play().catch(() => {});
                });
            return;
        }

        // 3) HTMLAudio fallback
        try {
            const a = new Audio(path);
            a.loop = true;
            a.volume = targetVolume;
            this.supermarketAmbienceAudio = a;
            a.play().catch(() => {});
        } catch (e) {}
    }

    stopSupermarketAmbience() {
        if (this._supermarketAmbienceRetryInterval) {
            try { clearInterval(this._supermarketAmbienceRetryInterval); } catch (e) {}
            this._supermarketAmbienceRetryInterval = null;
        }

        if (this._supermarketAmbienceEl && this._supermarketAmbienceEl.components && this._supermarketAmbienceEl.components.sound) {
            try {
                if (typeof this._supermarketAmbienceEl.components.sound.stopSound === 'function') {
                    this._supermarketAmbienceEl.components.sound.stopSound();
                }
            } catch (e) {}
        }
        this._supermarketAmbienceEl = null;

        if (this._supermarketAmbienceSource) {
            try { this._supermarketAmbienceSource.stop(); } catch (e) {}
            try { this._supermarketAmbienceSource.disconnect(); } catch (e) {}
            this._supermarketAmbienceSource = null;
        }
        if (this._supermarketAmbienceGain) {
            try { this._supermarketAmbienceGain.disconnect(); } catch (e) {}
            this._supermarketAmbienceGain = null;
        }

        if (this.supermarketAmbienceAudio) {
            try {
                this.supermarketAmbienceAudio.pause();
                this.supermarketAmbienceAudio.currentTime = 0;
            } catch (e) {}
            this.supermarketAmbienceAudio = null;
        }
    }

    /**
     * Zeigt Status-Information an
     */
    updateStatusDisplay() {
        const levelNames = ['Aus', 'Leicht', 'Mittel', 'Stark'];
        console.log(`Aktuelle Intensität: ${levelNames[this.distractionLevel]}`);

        this.updateVrHud();
    }

    /**
     * Kleine Hilfsfunktionen für Lesbarkeit
     */
    randomChoice(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    clamp01(v) {
        return Math.max(0, Math.min(1, v));
    }

    /**
     * Erstellt Focus Tunnel Effekt (Vignette)
     */
    createFocusTunnel(durationMs = 6000) {
        const camera = document.querySelector('a-camera') || document.querySelector('[camera]');
        if (!camera) return;

        // Entferne alten Tunnel falls vorhanden
        if (this._focusTunnelElement && this._focusTunnelElement.parentNode) {
            this._focusTunnelElement.parentNode.removeChild(this._focusTunnelElement);
        }

        // Erstelle neuen Tunnel als Ring mit Gradient
        const tunnel = document.createElement('a-ring');
        tunnel.setAttribute('position', '0 0 -0.5');
        tunnel.setAttribute('radius-inner', '0.85');
        tunnel.setAttribute('radius-outer', '2.5');
        tunnel.setAttribute('material', 'shader: flat; color: #0a0a0a; opacity: 0; transparent: true; side: double');
        tunnel.setAttribute('segments-theta', '64');
        
        camera.appendChild(tunnel);
        this._focusTunnelElement = tunnel;
        this._focusTunnelActive = true;
        this._focusTunnelUntil = Date.now() + durationMs;

        // Fade-in Animation
        let opacity = 0;
        const fadeInInterval = setInterval(() => {
            if (opacity < 0.65) {
                opacity += 0.05;
                tunnel.setAttribute('material', `shader: flat; color: #0a0a0a; opacity: ${opacity}; transparent: true; side: double`);
            } else {
                clearInterval(fadeInInterval);
            }
        }, 30);

        // Auto-remove nach Duration mit Fade-out
        setTimeout(() => {
            const fadeOutInterval = setInterval(() => {
                if (opacity > 0) {
                    opacity -= 0.05;
                    if (tunnel && tunnel.setAttribute) {
                        tunnel.setAttribute('material', `shader: flat; color: #0a0a0a; opacity: ${opacity}; transparent: true; side: double`);
                    }
                } else {
                    clearInterval(fadeOutInterval);
                    if (tunnel && tunnel.parentNode) {
                        tunnel.parentNode.removeChild(tunnel);
                    }
                    this._focusTunnelActive = false;
                }
            }, 30);
        }, durationMs - 500);
    }

    /**
     * Erstellt Screen Tint Effekt (für Nachgeben - Schuldgefühl)
     */
    createScreenTint(durationMs = 2500, color = '#ff4444') {
        const camera = document.querySelector('a-camera') || document.querySelector('[camera]');
        if (!camera) return;

        // Entferne alten Tint falls vorhanden
        if (this._screenTintElement && this._screenTintElement.parentNode) {
            this._screenTintElement.parentNode.removeChild(this._screenTintElement);
        }

        // Erstelle Screen Tint als Plane vor Kamera
        const tint = document.createElement('a-plane');
        tint.setAttribute('position', '0 0 -0.45');
        tint.setAttribute('width', '3');
        tint.setAttribute('height', '3');
        tint.setAttribute('material', `shader: flat; color: ${color}; opacity: 0; transparent: true; side: double`);
        
        camera.appendChild(tint);
        this._screenTintElement = tint;
        this._screenTintUntil = Date.now() + durationMs;

        // Pulse Animation
        let opacity = 0;
        let increasing = true;
        const pulseInterval = setInterval(() => {
            if (increasing) {
                opacity += 0.02;
                if (opacity >= 0.25) increasing = false;
            } else {
                opacity -= 0.015;
            }
            
            if (opacity <= 0) {
                clearInterval(pulseInterval);
                if (tint && tint.parentNode) {
                    tint.parentNode.removeChild(tint);
                }
            } else if (tint && tint.setAttribute) {
                tint.setAttribute('material', `shader: flat; color: ${color}; opacity: ${opacity}; transparent: true; side: double`);
            }
        }, 40);
    }

    // =============================================================
    // Desktop-Interaktion (nicht VR)

    // =============================================================
    ensureMouseRayCursor() {
        if (this._mouseCursorEnsured) return;

        const scene = document.querySelector('a-scene');
        const isVr = !!(scene && scene.is && scene.is('vr-mode'));
        if (isVr) return;

        const camera = document.querySelector('a-camera') || document.querySelector('[camera]');
        if (!camera) {
            setTimeout(() => this.ensureMouseRayCursor(), 250);
            return;
        }

        if (document.getElementById('adhs-mouse-cursor')) {
            this._mouseCursorEnsured = true;
            return;
        }

        const cursor = document.createElement('a-entity');
        cursor.setAttribute('id', 'adhs-mouse-cursor');
        cursor.setAttribute('cursor', 'rayOrigin: mouse; fuse: false');
        cursor.setAttribute('raycaster', 'objects: .adhs-clickable; far: 10');
        camera.appendChild(cursor);
        this._mouseCursorEnsured = true;
    }

    makeEntityClickable(el, meta = {}) {
        if (!el) return;
        try {
            this.ensureMouseRayCursor();
            el.classList.add('adhs-clickable');
            if (el.__adhsClickBound) return;
            el.__adhsClickBound = true;
            el.addEventListener('click', (ev) => {
                try { ev && ev.stopPropagation && ev.stopPropagation(); } catch (e) {}
                this.handleUserGaveIn(meta, el);
            });
        } catch (e) {
            
        }
    }

    // =============================================================
    // User Event: "Nachgeben" (G / Klick auf Ablenkung)
    // Effekt: Stress steigt, Progress sinkt, ggf. Prokrastination + Task-Pileup.
    // Das ist bewusst „spürbar“, damit die Mechanik im Gefühl ankommt.
    // =============================================================
    handleUserGaveIn(meta = {}, clickedEl = null) {
        if (!this.active || this.paused || this.distractionLevel <= 0) return;

        const now = Date.now();
        const level = this.distractionLevel;
        const severity = typeof meta.severity === 'number' ? meta.severity : 1.0;
        const label = meta.label || meta.type || 'Ablenkung';

        // Session metric
        this._totalGiveIns = (Number(this._totalGiveIns) || 0) + 1;

        // Stress-Spirale: Häufiges Nachgeben in kurzer Zeit erhöht den Multiplier
        const spiralWindow = 15000; // 15 Sekunden
        if ((now - this._lastGiveInAt) < spiralWindow) {
            this._giveInCount++;
            this._giveInSpiralMultiplier = Math.min(3.0, 1.0 + (this._giveInCount * 0.3));
        } else {
            this._giveInCount = 1;
            this._giveInSpiralMultiplier = 1.0;
        }
        this._lastGiveInAt = now;

        // Nachgeben -> Stress steigt ("Zeit weg", "schon wieder", etc.) - MIT SPIRALE
        const baseStressInc = (0.025 + 0.015 * level) * Math.max(0.5, Math.min(1.6, severity));
        const stressInc = baseStressInc * this._giveInSpiralMultiplier; // Kerneffekt: wiederholtes Nachgeben verstärkt Stress ("Spirale").
        this.stress = this.clamp01((this.stress || 0) + stressInc);
        this._stressPeak = Math.max(Number(this._stressPeak) || 0, Number(this.stress) || 0);

        // Zeitverlust berechnen und tracken
        const timeWasted = Math.floor(2 + (3 * level) + (2 * severity)); // Modelliert "Zeit weg" (wird in der UI als Minuten angezeigt).
        this._totalTimeWasted += timeWasted * 60; // in Sekunden

        // Screen Tint Effekt (Schuldgefühl/"Mist!"-Moment sichtbar machen)
        this.createScreenTint(2500, '#ff4444');

        // Hyperfokus kann durch Interaktion abrupt abbrechen
        if (this.taskState === 'hyperfocus') {
            this._hyperfocusUntil = 0;
        }

        // Wenn man eigentlich arbeitet: Klick schubst in Prokrastination
        if (this.taskState === 'working' || this.taskState === 'hyperfocus') {
            const dur = 1800 + Math.random() * 2200 + 700 * severity;
            this.setTaskState('procrastinating', dur); // Nachgeben unterbricht "Flow" → zurück in Prokrastination.
        }

        // Größere Progress-Strafe (deutlich spürbar)
        try {
            const t = this.getActiveTask();
            if (t) {
                const dec = (0.025 + 0.02 * level) * (0.8 + 0.7 * severity) * this._giveInSpiralMultiplier;
                t.progress = Math.max(0, (t.progress || 0) - dec); // Progress-Strafe: fühlt sich wie "zurückgeworfen" an.
            }
        } catch (e) {}

        // Aufgaben-Pile-Up: Bei Stress > 0.5 spawnen zusätzliche Mini-Aufgaben
        if (this.stress > 0.5 && Math.random() < 0.35) {
            // "Pile-Up": Unter Stress entstehen zusätzliche Kleinst-Aufgaben (Overwhelm-Effekt).
            const pileUpTasks = [
                { text: 'Jetzt auch noch Mails checken', kind: 'email', progress: 0 },
                { text: 'Termin bestätigen', kind: 'planning', progress: 0 },
                { text: 'Nachricht beantworten', kind: 'social', progress: 0 },
                { text: 'Wichtiges nicht vergessen', kind: 'planning', progress: 0 },
                { text: 'Schnell was googeln', kind: 'planning', progress: 0 }
            ];
            const newTask = this.randomChoice(pileUpTasks);
            this.tasks.push(newTask);
            console.log(`[Pile-Up] Neue Aufgabe: ${newTask.text}`);
        }

        // Zeitverlust-Nachricht mit Spirale-Info
        const spiralMsg = this._giveInSpiralMultiplier > 1.5 ? ' (Stress-Spirale!)' : '';
        this._actionMsg = `${label} - ${timeWasted} Min. verloren${spiralMsg}`;
        this._actionMsgUntil = now + 3500;

        // Refocus-Streak bricht beim bewussten "Nachgeben"
        this._refocusStreak = 0;
        this._refocusBoost = 0;
        this._refocusBoostUntil = 0;

        // Visuelles Feedback: angeklicktes Element schneller entfernen
        try {
            if (clickedEl && clickedEl.parentNode) clickedEl.parentNode.removeChild(clickedEl);
        } catch (e) {}

        this.updateTaskPanel();
        this.updateVrHud();
    }

    // =============================================================
    // User Event: "Refocus" (R)
    // Effekt: Ablenkungen werden aufgeräumt, Stress sinkt, kurzer Schutz vor neuen
    // Unterbrechungen + Rückkehr zu working (Wiedereinstieg ist trotzdem teuer).
    // =============================================================
    handleUserRefocus() {
        if (!this.active || this.paused || this.distractionLevel <= 0) return;

        const now = Date.now();
        const level = this.distractionLevel;

        // Session metric
        this._totalRefocus = (Number(this._totalRefocus) || 0) + 1;

        const prevState = this.taskState;
        const cameFromProcrastination = prevState === 'procrastinating';

        // VERBESSERT: Längerer Schutz (4-8 Sekunden statt 1-2s)
        const shieldBaseByLevel = [0, 7500, 6000, 4500];
        const shieldJitterByLevel = [0, 1500, 1500, 1000];
        const shieldBase = shieldBaseByLevel[level] || 6000;
        const shieldJitter = shieldJitterByLevel[level] || 1500;
        this._refocusShieldUntil = now + shieldBase + Math.random() * shieldJitter; // Soft-Shield: in dieser Zeit werden neue Reize eher unterdrückt.

        // VERBESSERT: Längerer "Hard Lock"
        const lockBaseByLevel = [0, 3500, 2800, 2200];
        const lockJitterByLevel = [0, 500, 400, 300];
        this._refocusHardLockUntil = now + (lockBaseByLevel[level] || 2500) + Math.random() * (lockJitterByLevel[level] || 400); // Hard-Lock: kurzzeitige "Ruhe", damit Refocus nicht sofort wieder kippt.

        // Focus Tunnel Effekt (visuelles Feedback)
        const tunnelDuration = 5000 + (this._refocusStreak || 0) * 1000; // länger bei Streak
        this.createFocusTunnel(tunnelDuration);

        // Sofort sichtbarer "Reset"-Cue (gruen), damit Refocus auch ohne ToDo-Panel auffaellt.
        try { this.createScreenTint(700, '#22c55e'); } catch (e) {}

        // Sofortiges Aufräumen: aktuelle Ablenkungen "weg"
        try { this.clearAllDistractions(); } catch (e) {} // UI/VR wird sofort "ruhiger".

        // VERBESSERT: Stress sinkt drastisch (-20% statt -8%)
        const stressReduction = 0.15 + (0.05 * (this._refocusStreak || 0) / 5); // mehr bei Streak
        this.stress = this.clamp01((this.stress || 0) - stressReduction); // Kerneffekt: Stress-Reset durch bewusstes Zurückfokussieren.
        this._stressPeak = Math.max(Number(this._stressPeak) || 0, Number(this.stress) || 0);
        
        const reentryByLevel = [0, 1100, 1600, 2200];
        this._reentryUntil = now + (reentryByLevel[level] || 1400) + Math.random() * 500; // Wiedereinstieg bleibt "teuer", auch wenn man Refocus drückt.
        this.setTaskState('working', 0); // Zurück zur Aufgabe.

        // VERBESSERT: Längerer Focus Mode
        const focusDurByLevel = [0, 12000, 10000, 8000];
        this._focusModeUntil = now + (focusDurByLevel[level] || 10000); // Nach Refocus kurz bessere "Stabilität".

        // Stress-Spirale zurücksetzen bei erfolgreichem Refocus
        this._giveInCount = 0;
        this._giveInSpiralMultiplier = 1.0;

        // Sanft zurück zur Hauptaufgabe (deepwork), falls vorhanden
        try {
            if (this.tasks && this.tasks.length) {
                const deepIdx = this.tasks.findIndex(t => (t && t.kind === 'deepwork') && ((t.progress || 0) < 1));
                if (deepIdx >= 0) this.activeTaskIndex = deepIdx;
            }
        } catch (e) {}

        // VERBESSERT: Bessere Belohnung + Streak
        if (cameFromProcrastination) {
            const streakWindowMs = 25000; // etwas längeres Fenster
            const prevAt = this._lastRefocusAt || 0;
            const nextStreak = (now - prevAt) <= streakWindowMs ? ((this._refocusStreak || 0) + 1) : 1;
            this._refocusStreak = Math.max(1, Math.min(10, nextStreak)); // max 10 statt 5
            this._lastRefocusAt = now;

            try {
                const t = this.getActiveTask();
                if (t) {
                    // VERBESSERT: 3-8% Progress statt 0.6-2%
                    const levelScale = (level === 3) ? 0.75 : (level === 2) ? 0.90 : 1.0;
                    const streakBonus = 1.0 + (this._refocusStreak - 1) * 0.15; // +15% pro Streak
                    const bonus = (0.03 + Math.random() * 0.05) * levelScale * streakBonus;
                    t.progress = Math.min(1, (t.progress || 0) + bonus); // Belohnung: "Es lohnt sich", wieder reinzugehen.
                }
            } catch (e) {}

            // VERBESSERT: Starker Hyperfokus-Boost bei Streaks (bei 3+ Streak: bis zu 25% Chance)
            const baseBoost = 0.005 * (this._refocusStreak || 0);
            const streakMultiplier = this._refocusStreak >= 3 ? 3.0 : 1.5;
            this._refocusBoost = baseBoost * streakMultiplier; // bis zu ~15%
            this._refocusBoostUntil = now + 15000 + 3000 * ((this._refocusStreak || 1) - 1);
            
            // Bei hohem Streak: Chance auf sofortigen Hyperfokus
            if (this._refocusStreak >= 4 && Math.random() < 0.3) {
                const hyperfocusDur = 8000 + Math.random() * 6000;
                this._hyperfocusUntil = now + hyperfocusDur;
                this.setTaskState('hyperfocus', hyperfocusDur);
                console.log('[Refocus] Hyperfokus erreicht! (Streak: ' + this._refocusStreak + ')');
            }
        } else {
            this._lastRefocusAt = now;
        }

        this._actionMsg = (this._refocusStreak && this._refocusStreak > 1)
            ? `FOCUS MODE: Zurück zur Aufgabe (${this._refocusStreak}x)`
            : 'FOCUS MODE: Zurück zur Aufgabe';
        this._actionMsgUntil = now + 2600;

        // Starker Cue in die "richtige" Richtung (ohne Zwangsdrehung)
        try {
            const target = (typeof this.getRefocusTargetWorldPos === 'function') ? this.getRefocusTargetWorldPos() : null;
            if (target) {
                this.createGazeCue(target.x, target.y, target.z, 1350);
                // Zusätzlich: auffälliger Spotlight direkt am Ziel (Desktop + VR)
                this.createRefocusSpotlight(target.x, target.y, target.z, 1600);
            }
        } catch (e) {}

        // Task-adjacent Cue: direkt nach Refocus eher "zurück zum Kontext" statt random Ablenkung
        if (this.environment === 'desk') {
            this.createMonitorMicroDistraction({ reason: 'refocus' });
        } else {
            this.showNotification({ reason: 'refocus' });
        }

        this.updateTaskPanel();
        this.updateVrHud();
    }

    removeAfter(element, ms) {
        setTimeout(() => {
            if (element.parentNode) element.parentNode.removeChild(element);
            const index = this.visualDistractions.indexOf(element);
            if (index > -1) this.visualDistractions.splice(index, 1);
        }, ms);
    }

    /**
     * Passt die Umgebungsbeleuchtung an die Intensität an
     */
    adjustEnvironmentLighting(level) {
        const ambientLight = document.querySelector('#ambient-light');
        const hemisphereLight = document.querySelector('#hemisphere-light');
        const directionalLight = document.querySelector('#directional-light');
        
        // Basis-Intensitäten
        const baseAmbient = 0.15;
        const baseHemisphere = 0.2;
        const baseDirectional = 0.1;
        
        // Dimm-Faktoren je nach Level (0 = normal, 3 = sehr dunkel)
        const dimmingFactors = [1.0, 0.7, 0.4, 0.2];
        const factor = dimmingFactors[level];
        
        if (ambientLight) {
            ambientLight.setAttribute('light', 'intensity', baseAmbient * factor);
        }
        if (hemisphereLight) {
            hemisphereLight.setAttribute('light', 'intensity', baseHemisphere * factor);
        }
        if (directionalLight) {
            directionalLight.setAttribute('light', 'intensity', baseDirectional * factor);
        }
    }

    /**
     * Kurz dimmen für Effekt
     */
    dimEnvironmentTemporarily(duration = 2000) {
        const ambientLight = document.querySelector('#ambient-light');
        const hemisphereLight = document.querySelector('#hemisphere-light');
        const directionalLight = document.querySelector('#directional-light');
        
        if (!ambientLight || !hemisphereLight || !directionalLight) return;
        
        // Aktuelle Werte speichern
        const originalAmbient = parseFloat(ambientLight.getAttribute('light').intensity);
        const originalHemisphere = parseFloat(hemisphereLight.getAttribute('light').intensity);
        const originalDirectional = parseFloat(directionalLight.getAttribute('light').intensity);
        
        // Auf 30% dimmen
        ambientLight.setAttribute('light', 'intensity', originalAmbient * 0.3);
        hemisphereLight.setAttribute('light', 'intensity', originalHemisphere * 0.3);
        directionalLight.setAttribute('light', 'intensity', originalDirectional * 0.3);
        
        // Nach duration zurücksetzen
        setTimeout(() => {
            if (ambientLight) ambientLight.setAttribute('light', 'intensity', originalAmbient);
            if (hemisphereLight) hemisphereLight.setAttribute('light', 'intensity', originalHemisphere);
            if (directionalLight) directionalLight.setAttribute('light', 'intensity', originalDirectional);
        }, duration);
    }

    /**
     * Erzeugt visuelle Ablenkung
     */
    spawnVisualDistraction(opts = {}) {
        const scene = document.querySelector('a-scene');
        if (!scene) return;

        const allowBurst = !(opts && opts.noBurst);

        // Hyperfokus: Reize sind "ausgeblendet" (nicht komplett weg, aber deutlich weniger)
        if (this.isHyperfocusActive()) {
            const skipChanceByLevel = [0, 0.55, 0.62, 0.70];
            if (Math.random() < (skipChanceByLevel[this.distractionLevel] || 0.6)) return;
        }

        // Kurz nach Refocus: deutlich weniger neue Reize
        if (this.isRefocusShieldActive && this.isRefocusShieldActive()) {
            // Bei hoher Intensität ist es spürbar, aber nicht "magisch".
            const skipChanceByLevel = [0, 0.88, 0.84, 0.78];
            if (Math.random() < (skipChanceByLevel[this.distractionLevel] || 0.83)) return;
        }

        // Direkt nach Refocus: absoluter Lock (damit Refocus sofort spürbar ist)
        if (this.isRefocusHardLockActive && this.isRefocusHardLockActive()) return;

        // Neue Typen: Gedankenblase
        const types = this.environment === 'hoersaal'
            ? ['flashingLight', 'flashingLight', 'peripheralMovement', 'thoughtBubble']
            : (this.environment === 'desk'
                ? [
                    // Desk: eher "Monitor/PC" als fliegende Objekte
                                        'monitorMicro', 'monitorMicro', 'monitorMicro',
                                        'screenFlicker', 'screenFlicker',
                                        'flashingLight',
                    'largePopup', 'peripheralMovement', 'thoughtBubble', 'movingObject'
                  ]
                : ['movingObject', 'movingObject', 'peripheralMovement', 'peripheralMovement', 'thoughtBubble']);
        // Prokrastination: mehr "tempting" Screen-Reize; Working: etwas weniger
        let bag = types.slice();
        if (this.environment === 'desk') {
            if (this.taskState === 'procrastinating') bag = bag.concat(['monitorMicro', 'monitorMicro', 'largePopup']);
            if (this.taskState === 'working') bag = bag.filter(t => t !== 'movingObject');

            // Re-Entry: eher "task-adjacent" Monitor/Screen, weniger Social/Popups
            const isReentry = (this.taskState === 'working' && this.isReentryActive && this.isReentryActive());
            if (isReentry) {
                bag = bag.filter(t => t !== 'largePopup' && t !== 'movingObject');
                bag = bag.concat(['monitorMicro', 'monitorMicro', 'screenFlicker']);
            }
        }

        // Habituation: wiederholte Typen werden wahrscheinlicher "ausgeblendet" (reroll)
        let type = this.randomChoice(bag);
        for (let tries = 0; tries < 2; tries++) {
            const f = (this.getHabituationFactor ? this.getHabituationFactor('visual', type) : 1.0);
            if (f >= 0.60) break;
            type = this.randomChoice(bag);
        }
        if (this.noteStimulus) this.noteStimulus('visual', type);
        switch(type) {
            case 'largePopup':
                this.createLargePopup();
                break;
            case 'movingObject':
                this.createMovingDistraction();
                break;
            case 'flashingLight':
                this.createFlashingLight();
                break;
            case 'peripheralMovement':
                this.createPeripheralMovement();
                break;
            case 'thoughtBubble':
                this.createThoughtBubble();
                break;
            case 'monitorMicro':
                this.createMonitorMicroDistraction();
                break;
            case 'screenFlicker':
                this.createScreenFlicker();
                break;
        }

        // Intensität spürbarer machen: bei Mittel/Stark kommen Reize manchmal in „Clustern“.
        // (Nur sichere, kurze Typen; keine aggressiven Forced-Looks.)
        if (
            allowBurst &&
            this.distractionLevel >= 2 &&
            !(this.isHyperfocusActive && this.isHyperfocusActive()) &&
            !(this.isRefocusShieldActive && this.isRefocusShieldActive())
        ) {
            const extraChance = this.distractionLevel === 3 ? 0.22 : 0.12;
            const maxActive = this.environment === 'desk' ? 4 : 3;
            if ((this.visualDistractions || []).length < maxActive && Math.random() < extraChance) {
                setTimeout(() => {
                    if (!this.active || this.paused || this.distractionLevel <= 0) return;
                    if (this.isHyperfocusActive && this.isHyperfocusActive()) return;
                    if (this.isRefocusShieldActive && this.isRefocusShieldActive()) return;

                    if (this.environment === 'desk') {
                        this.createMonitorMicroDistraction({ reason: 'burst' });
                    } else if (this.environment === 'hoersaal') {
                        this.createThoughtBubble();
                    } else {
                        this.createPeripheralMovement();
                    }
                }, 180 + Math.random() * 170);
            }
        }
    }

    isVrMode() {
        const scene = document.querySelector('a-scene');
        return !!(scene && scene.is && scene.is('vr-mode'));
    }

    getWorldPos(el) {
        if (!el) return null;
        try {
            const v = new THREE.Vector3();
            el.object3D.getWorldPosition(v);
            return { x: v.x, y: v.y, z: v.z };
        } catch (e) {
            const p = el.getAttribute('position');
            if (!p) return null;
            return { x: p.x || 0, y: p.y || 0, z: p.z || 0 };
        }
    }

    getRigWorldPos() {
        const rig = document.querySelector('#rig');
        return this.getWorldPos(rig) || { x: 0, y: 0, z: 0 };
    }

    getNearestElementTo(pos, elements) {
        try {
            if (!pos || !elements || !elements.length) return null;
            let best = null;
            let bestD = Infinity;
            for (const el of elements) {
                const wp = this.getWorldPos(el);
                if (!wp) continue;
                const dx = wp.x - pos.x;
                const dy = wp.y - pos.y;
                const dz = wp.z - pos.z;
                const d = dx * dx + dy * dy + dz * dz;
                if (d < bestD) {
                    bestD = d;
                    best = el;
                }
            }
            return best;
        } catch (e) {
            return null;
        }
    }

    // Where should Refocus guide the user back to?
    getRefocusTargetWorldPos() {
        try {
            const env = this.environment || 'desk';

            if (env === 'desk') {
                const m = document.querySelector('#monitor1') || document.querySelector('#monitor2');
                const wp = this.getWorldPos(m);
                return wp ? { x: wp.x, y: wp.y + 0.12, z: wp.z } : null;
            }

            if (env === 'supermarkt') {
                const rigPos = this.getRigWorldPos();
                const aisles = Array.from(document.querySelectorAll('#shelves > a-entity'));
                const nearest = this.getNearestElementTo(rigPos, aisles);
                const wp = this.getWorldPos(nearest || document.querySelector('#shelves'));
                if (wp) return { x: wp.x, y: wp.y + 1.1, z: wp.z };
                return { x: 0, y: 1.2, z: -2.5 };
            }

            if (env === 'hoersaal') {
                const prof = document.querySelector('#prof');
                const wpProf = this.getWorldPos(prof);
                if (wpProf) return { x: wpProf.x, y: wpProf.y + 0.25, z: wpProf.z };
                return { x: 0, y: 2.6, z: -6.8 };
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    // --- Desk: kleine, realistische Monitor-Ablenkungen (Discord/Update/Shorts) ---
    createMonitorMicroDistraction(opts = {}) {
        if (this.environment !== 'desk') return;

        const monitorEls = [document.querySelector('#monitor1'), document.querySelector('#monitor2')].filter(Boolean);
        if (!monitorEls.length) return;

        const monitorEl = this.randomChoice(monitorEls);
        const isLeft = monitorEl.getAttribute('id') === 'monitor1';
        const monitorId = monitorEl.getAttribute('id') || (isLeft ? 'monitor1' : 'monitor2');

        const task = this.getActiveTask ? this.getActiveTask() : { kind: 'misc', text: '' };

        const variantsCommon = [
            { title: 'Discord', body: '„Nur kurz“: 1 neue Nachricht', accent: '#5865f2', icon: '💬' },
            { title: 'YouTube', body: 'Shorts: „2 Min Tutorial“', accent: '#ef4444', icon: '▶' },
            { title: 'System', body: 'Achtung: Akku 20%', accent: '#f59e0b', icon: '⚠' }
        ];
        const variantsByKind = {
            deepwork: [
                { title: 'GitHub', body: 'PR: „Nur kurz reviewen…“', accent: '#a78bfa', icon: '🧩' },
                { title: 'Docs', body: '„Ich schau nur schnell nach…“', accent: '#0ea5e9', icon: '🔎' },
                { title: 'Build', body: 'Fehler: 1 Warnung (fix?)', accent: '#f97316', icon: '🛠' }
            ],
            email: [
                { title: 'Mail', body: 'Neue Nachricht: „kurze Rückfrage“', accent: '#38bdf8', icon: '✉' },
                { title: 'Kalender', body: 'Meeting in 15 Min (prep?)', accent: '#60a5fa', icon: '📅' },
                { title: 'Slack', body: 'Ping: „Hast du kurz Zeit?“', accent: '#22c55e', icon: '💬' }
            ],
            planning: [
                { title: 'Notizen', body: '„Noch schnell“ 3 neue Punkte', accent: '#f59e0b', icon: '🗒' },
                { title: 'Shop', body: '„Nur kurz Preise vergleichen…“', accent: '#fb7185', icon: '🛒' }
            ],
            chores: [
                { title: 'Playlist', body: '„Nur kurz Song wechseln…“', accent: '#a855f7', icon: '🎵' },
                { title: 'Messenger', body: '„Bin gleich da…“', accent: '#38bdf8', icon: '💬' }
            ],
            social: [
                { title: 'Messenger', body: '„Nur kurz antworten…“', accent: '#38bdf8', icon: '💬' },
                { title: 'Anruf', body: 'Verpasster Anruf', accent: '#ef4444', icon: '📞' }
            ]
        };

        const isProcrastinating = this.taskState === 'procrastinating';
        const isInterrupt = opts && opts.reason === 'interrupt';
        const isReentry = (opts && opts.reason === 'reentry') || (this.taskState === 'working' && this.isReentryActive && this.isReentryActive());
        const isRefocus = opts && opts.reason === 'refocus';
        let pool = [];

        // Prokrastination: eher "Entertainment"/Chat.
        // Re-Entry: mehr "task-adjacent" (Build/Docs/PR), weniger tempting.
        // Working: Mischung, aber weniger extrem.
        if (isRefocus) {
            const systemOnly = variantsCommon.filter(v => v.title === 'System');
            pool = pool.concat(
                (variantsByKind[task.kind] || []),
                (variantsByKind[task.kind] || []),
                systemOnly,
                [{ title: 'Zurück zur Aufgabe', body: 'Weiter im aktuellen Tab', accent: '#22c55e', icon: '↩' }]
            );
        } else if (isProcrastinating || isInterrupt) {
            pool = pool.concat(variantsCommon, [{ title: 'Steam', body: 'Update verfügbar (jetzt?)', accent: '#0ea5e9', icon: '💾' }]);
        } else if (isReentry) {
            const systemOnly = variantsCommon.filter(v => v.title === 'System');
            pool = pool.concat(
                (variantsByKind[task.kind] || []),
                (variantsByKind[task.kind] || []),
                systemOnly,
                [{ title: 'Zurück', body: 'Wo war ich…? Kontext wiederfinden', accent: '#64748b', icon: '↩' }]
            );
        } else {
            pool = pool.concat((variantsByKind[task.kind] || []), variantsCommon);
        }

        // Intensität beeinflusst die „Qualität“ des Reizes.
        // Level 1: mehr neutral/task-adjacent (wirkt wie produktives Chaos)
        // Level 3: mehr tempting/social (zieht stärker weg)
        if (!isRefocus) {
            const lvl = this.distractionLevel || 0;
            const taskAdj = (variantsByKind[task.kind] || []);
            const tempting = variantsCommon.filter(v => v.title === 'Discord' || v.title === 'YouTube');
            const neutral = variantsCommon.filter(v => v.title === 'System');

            if (lvl === 1 && !(isProcrastinating || isInterrupt)) {
                // Beim Arbeiten auf niedrig: eher „Docs/Build/PR“ + System, wenig Entertainment
                pool = pool.concat(taskAdj, taskAdj, neutral);
                pool = pool.filter(v => v.title !== 'YouTube').concat(neutral);
            } else if (lvl === 3 && !(isReentry || isRefocus)) {
                // Bei stark: selbst beim Arbeiten drängt mehr tempting rein
                pool = pool.concat(tempting, tempting, [{ title: 'Steam', body: 'Update verfügbar (jetzt?)', accent: '#0ea5e9', icon: '💾' }]);
            }
        }

        const v = this.randomChoice(pool);

        // Kleine Overlay-Card auf dem Monitor
        const card = document.createElement('a-entity');

        // Overlap-Fix: pro Monitor nur eine Micro-Card gleichzeitig.
        // (Sonst stapeln sich transparente Karten und "Messages" wirken ueberlagert.)
        try {
            if (!this._activeMonitorMicroCards) this._activeMonitorMicroCards = new Map();
            const prev = this._activeMonitorMicroCards.get(monitorId);
            if (prev && prev.card) {
                try { if (prev.timer) clearTimeout(prev.timer); } catch (e) {}
                try {
                    if (prev.card.parentNode) prev.card.parentNode.removeChild(prev.card);
                } catch (e) {}
                try {
                    const idx = this.visualDistractions.indexOf(prev.card);
                    if (idx > -1) this.visualDistractions.splice(idx, 1);
                } catch (e) {}
            }
        } catch (e) {}

        // Exakt innerhalb der Screen-Plane platzieren (damit nichts "vom Monitor hängt").
        // Screen in desk.html: width=0.56 height=0.315 bei z=0.025
        const screenW = 0.56;
        const screenH = 0.315;
        const cardW = 0.38;
        const cardH = 0.16;
        const margin = 0.012;
        const maxX = Math.max(0, (screenW - cardW) / 2 - margin);
        const maxY = Math.max(0, (screenH - cardH) / 2 - margin);

        // Default: oben rechts, mit minimalem Jitter (wirkt "lebendig", bleibt aber sauber auf dem Screen).
        let x = maxX + (Math.random() * 0.02 - 0.01);
        let y = maxY + (Math.random() * 0.02 - 0.01);
        x = Math.max(-maxX, Math.min(maxX, x));
        y = Math.max(-maxY, Math.min(maxY, y));

        // Sehr nah an der Screen-Plane, um "auf dem Monitor" zu wirken (aber ohne Z-Fighting).
        const z = 0.0265;
        card.setAttribute('position', `${x.toFixed(3)} ${y.toFixed(3)} ${z}`);
        card.setAttribute('rotation', '0 0 0');
        card.__adhsMonitorMicro = true;
        card.innerHTML = `
            <a-plane width="0.38" height="0.16" material="color:#0b1020; opacity:0.75; transparent:true; shader:flat" position="0 0 0"></a-plane>
            <a-plane width="0.01" height="0.16" material="color:${v.accent}; shader:flat" position="-0.185 0 0.001"></a-plane>
            <a-troika-text value="${v.icon} ${v.title}" max-width="0.34" font-size="0.030" color="#e5e7eb" position="-0.165 0.045 0.002" align="left" anchor="left" baseline="center"></a-troika-text>
            <a-troika-text value="${v.body}" max-width="0.34" font-size="0.028" color="#cbd5e1" position="-0.165 -0.02 0.002" align="left" anchor="left" baseline="center" fill-opacity="0.85"></a-troika-text>
            <a-animation attribute="scale" from="0.92 0.92 0.92" to="1 1 1" dur="220" easing="easeOutQuad"></a-animation>
        `;
        monitorEl.appendChild(card);
        this.visualDistractions.push(card);

        // Interaktiv: Klick auf die Card = "nachgeben" (Refocus-Cue soll nicht "bestrafen")
        if (!isRefocus) {
            this.makeEntityClickable(card, { type: 'monitorMicro', label: `${v.title}`, severity: 1.0 });
        }

        // Kein "Handyton" auf dem Monitor: Handyton/Vibration soll nur bei echten Handy-Nachrichten kommen.
        // Stattdessen: sehr leiser elektrischer Tick.
        if (!isRefocus) {
            const ctx = this.getAudioContext();
            if (ctx) this.playTinyElectricalTick(ctx, { volume: 0.035, pan: isLeft ? -0.25 : 0.25 });
        }

        // Desk: häufiger ein Cue (ohne Kopfzwang) – damit "mehr passiert" ohne Stress
        if (this.environment === 'desk') {
            const cueChanceByLevel = [0, 0.22, 0.40, 0.58];
            const cueChance = cueChanceByLevel[this.distractionLevel] || 0;
            if (!isRefocus && Math.random() < cueChance) {
                const wp = this.getWorldPos(monitorEl);
                if (wp) this.createGazeCue(wp.x, wp.y + 0.1, wp.z, 850 + Math.random() * 450);
            }
        }

        // Fokus-Shift: nur Blickhinweis (kein Forced-Look)
        const lookDuration = [0, 520, 850, 1200][this.distractionLevel];
        const lookChanceByLevel = [0, 0.18, 0.28, 0.42];
        const lookChance = lookChanceByLevel[this.distractionLevel] || 0;
        if (!isRefocus && lookDuration > 0 && Math.random() < lookChance) {
            const wp = this.getWorldPos(monitorEl);
            if (wp) {
                setTimeout(() => this.createGazeCue(wp.x, wp.y + 0.1, wp.z, lookDuration), 250);
            }
        }

        const level = this.distractionLevel || 0;
        const baseLifeByLevel = isRefocus ? [0, 1200, 1350, 1500] : [0, 1600, 2300, 3100];
        const jitterByLevel = isRefocus ? [0, 500, 500, 500] : [0, 900, 1100, 1300];
        const life = (baseLifeByLevel[level] || 1800) + Math.random() * (jitterByLevel[level] || 900);
        const timer = setTimeout(() => {
            try {
                if (card.parentNode) card.parentNode.removeChild(card);
            } catch (e) {}
            try {
                const idx = this.visualDistractions.indexOf(card);
                if (idx > -1) this.visualDistractions.splice(idx, 1);
            } catch (e) {}
            try {
                if (this._activeMonitorMicroCards && this._activeMonitorMicroCards.get(monitorId)?.card === card) {
                    this._activeMonitorMicroCards.delete(monitorId);
                }
            } catch (e) {}
        }, life);

        try {
            if (!this._activeMonitorMicroCards) this._activeMonitorMicroCards = new Map();
            this._activeMonitorMicroCards.set(monitorId, { card, timer });
        } catch (e) {}
    }

    // --- Desk: kurzer Flicker/Dim auf einem Monitor (wie Helligkeit schwankt / GPU/Auto-Dimming) ---
    createScreenFlicker() {
        if (this.environment !== 'desk') return;

        const monitorEls = [document.querySelector('#monitor1'), document.querySelector('#monitor2')].filter(Boolean);
        if (!monitorEls.length) return;
        const monitorEl = this.randomChoice(monitorEls);

        const flicker = document.createElement('a-entity');
        flicker.setAttribute('position', '0 0 0.032');
        flicker.innerHTML = `
            <a-plane width="0.56" height="0.315" material="color:#000000; opacity:0.0; transparent:true; shader:flat"></a-plane>
            <a-animation attribute="material.opacity" from="0.0" to="0.22" dur="90" direction="alternate" repeat="3" easing="linear"></a-animation>
        `;
        monitorEl.appendChild(flicker);
        this.visualDistractions.push(flicker);

        // Leises elektrisches "tick"/mouseclick als Ersatz für echtes Bildschirmfiepen
        const ctx = this.getAudioContext();
        if (ctx) {
            const isLeft = monitorEl.getAttribute('id') === 'monitor1';
            this.playMouseClick(ctx, { volume: 0.06, pan: isLeft ? -0.2 : 0.2 });
        }

        setTimeout(() => {
            if (flicker.parentNode) flicker.parentNode.removeChild(flicker);
            const idx = this.visualDistractions.indexOf(flicker);
            if (idx > -1) this.visualDistractions.splice(idx, 1);
        }, 420);
    }

    // Desk: kurzer "Glare" im Sichtfeld (wie Monitorblendung/Auto-Dimming), ohne Kopfzwang.
    createCameraGlareFlash(intensity = 0.12, durationMs = 420) {
        const camera = document.querySelector('a-camera') || document.querySelector('[camera]');
        if (!camera) return;

        const glare = document.createElement('a-entity');
        glare.setAttribute('position', '0 0 -0.65');
        glare.setAttribute('rotation', '0 0 0');
        const alpha = Math.max(0.04, Math.min(0.22, intensity));
        const dur = Math.max(260, Math.min(900, durationMs));
        glare.innerHTML = `
            <a-plane width="0.9" height="0.55" material="color:#ffffff; opacity:0.0; transparent:true; shader:flat"></a-plane>
            <a-animation attribute="material.opacity" from="0.0" to="${alpha}" dur="80" direction="alternate" repeat="2" easing="easeInOutQuad"></a-animation>
            <a-animation attribute="material.opacity" from="${alpha}" to="0.0" dur="${dur}" easing="easeOutQuad"></a-animation>
        `;
        camera.appendChild(glare);
        this.visualDistractions.push(glare);

        setTimeout(() => {
            if (glare.parentNode) glare.parentNode.removeChild(glare);
            const idx = this.visualDistractions.indexOf(glare);
            if (idx > -1) this.visualDistractions.splice(idx, 1);
        }, dur + 120);
    }

    // Kleiner elektrischer Tick (sehr leise), um "Bildschirm/Netzteil" zu suggerieren
    playTinyElectricalTick(ctx, opts = {}) {
        const out = this.createSpatialOutput(ctx, {
            volume: typeof opts.volume === 'number' ? opts.volume : 0.06,
            pan: typeof opts.pan === 'number' ? opts.pan : 0
        });
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = 900 + Math.random() * 400;
        gain.gain.setValueAtTime(0.0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(1.0, ctx.currentTime + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
        osc.connect(gain);
        gain.connect(out);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.055);
    }

    /**
     * Große Notification vor der Kamera
     */
    createLargePopup() {
        // Rate limit: nur ein Smartphone-Popup in einem sinnvollen Abstand.
        // (Sonst wirkt es unrealistisch und spamt den Screen.)
        try {
            const now = Date.now();
            const minMs = Math.max(1800, Number(this._phonePopupMinMs) || 6500);
            if ((now - (this._lastPhonePopupAt || 0)) < (minMs * 0.9)) return;

            // Wenn noch ein Phone-Popup aktiv ist, keine zweite Instanz stapeln.
            const hasActive = (this.visualDistractions || []).some((d) => d && d.__adhsPhonePopup);
            if (hasActive) return;
            this._lastPhonePopupAt = now;
        } catch (e) {}

        try {
            this._popupCount = (this._popupCount || 0) + 1;
            if (this._debugNotif) {
                const badge = this._ensureDebugNotifBadge && this._ensureDebugNotifBadge();
                if (badge) badge.textContent = `notif: ${this._notifTickCount || 0} / popup: ${this._popupCount || 0}`;
            }
        } catch (e) {}

        const scene = document.querySelector('a-scene');
        const camera = document.querySelector('a-camera') || document.querySelector('[camera]');
        
        // Kontextspezifische Notifications je nach Umgebung
        const notificationsByEnvironment = {
            desk: [
                { app: 'Discord', sender: 'Zockerkumpels', text: 'Eine Runde zocken?', icon: '🎮', time: 'jetzt' },
                { app: 'YouTube', sender: 'Empfehlung', text: 'Neues Video von deinem Lieblingskanal', icon: '▶️', time: 'vor 2 Min' },
                { app: 'Steam', sender: 'Update', text: 'Download bereit: 47 GB', icon: '💾', time: 'jetzt' },
                { app: 'Instagram', sender: 'Lisa', text: 'hat dein Foto geliked', icon: '❤️', time: 'vor 1 Min' },
                { app: 'TikTok', sender: 'Trending', text: '12 neue Videos für dich', icon: '🎵', time: 'jetzt' },
                { app: 'Spotify', sender: 'Playlist', text: 'Deine Wochenübersicht ist da', icon: '🎧', time: 'vor 5 Min' },
                { app: 'Slack', sender: 'Team', text: 'Kurzer Ping: hast du kurz Zeit?', icon: '💬', time: 'jetzt' },
                { app: 'Kalender', sender: 'Erinnerung', text: 'Meeting in 30 Minuten', icon: '📅', time: 'jetzt' },
                { app: 'Mail', sender: 'Dozent', text: 'Reminder: Abgabe heute 23:59', icon: '📧', time: 'vor 6 Min' },
                { app: 'GitHub', sender: 'CI', text: 'Build fehlgeschlagen: Tests rot', icon: '🔧', time: 'jetzt' },
                { app: 'Lieferando', sender: 'Deal', text: 'Heute 2 für 1 auf Pizza', icon: '🍕', time: 'vor 3 Min' },
                { app: 'Wetter', sender: 'Warnung', text: 'Regen in 20 Minuten', icon: '🌧️', time: 'jetzt' }
            ],
            hoersaal: [
                { app: 'Mail', sender: 'Prof. Schmidt', text: 'Klausurtermin verschoben', icon: '📧', time: 'jetzt' },
                { app: 'WhatsApp', sender: 'Lerngruppe', text: 'Kommst du heute zum Lernen?', icon: '💬', time: 'jetzt' },
                { app: 'Kalender', sender: 'Erinnerung', text: 'Abgabe Hausarbeit in 2 Tagen', icon: '📅', time: 'jetzt' },
                { app: 'Moodle', sender: 'Neue Aufgabe', text: 'Übungsblatt 7 hochgeladen', icon: '📚', time: 'vor 10 Min' },
                { app: 'WhatsApp', sender: 'Mama', text: 'Kommst du am Wochenende?', icon: '👋', time: 'jetzt' },
                { app: 'Instagram', sender: 'Studigruppe', text: 'Story: Mensa closed today', icon: '📸', time: 'vor 3 Min' },
                { app: 'CampusApp', sender: 'Uni', text: 'Raumänderung: Hörsaal B statt A', icon: '🏫', time: 'jetzt' },
                { app: 'Telegram', sender: 'Kurschat', text: 'Hat jemand die Folien?', icon: '📎', time: 'jetzt' },
                { app: 'Kalender', sender: 'Erinnerung', text: 'Tutorium morgen 08:00', icon: '⏰', time: 'vor 2 Min' },
                { app: 'Mail', sender: 'Sekretariat', text: 'Anmeldung bestätigt', icon: '✅', time: 'vor 12 Min' },
                { app: 'Anruf', sender: 'Unbekannt', text: 'Eingehender Anruf...', icon: '📱', time: 'jetzt' }
            ],
            supermarkt: [
                { app: 'Einkaufsliste', sender: 'Reminder', text: 'Noch 3 Artikel übrig', icon: '📝', time: 'jetzt' },
                { app: 'Payback', sender: 'Angebot', text: '20% auf Getränke heute!', icon: '💰', time: 'jetzt' },
                { app: 'WhatsApp', sender: 'Partner', text: 'Vergiss die Milch nicht!', icon: '🥛', time: 'vor 1 Min' },
                { app: 'Banking', sender: 'Kontostand', text: 'Abbuchung: -47,23€', icon: '💳', time: 'jetzt' },
                { app: 'Lieferando', sender: 'Rabatt', text: 'Pizza bestellen & sparen', icon: '🍕', time: 'vor 5 Min' },
                { app: 'Anruf', sender: 'Unbekannt', text: 'Eingehender Anruf...', icon: '📱', time: 'jetzt' },
                { app: 'REWE', sender: 'App', text: 'Coupon verfügbar: -10% auf Obst', icon: '🍎', time: 'jetzt' },
                { app: 'Maps', sender: 'Erinnerung', text: 'Parkzeit läuft bald ab', icon: '🅿️', time: 'jetzt' },
                { app: 'PayPal', sender: 'Sicherheit', text: 'Neue Anmeldung erkannt', icon: '🔒', time: 'vor 4 Min' },
                { app: 'WhatsApp', sender: 'Freund', text: 'Bringst du Chips mit?', icon: '🥔', time: 'jetzt' },
                { app: 'Kalender', sender: 'Erinnerung', text: 'Arzttermin morgen', icon: '📅', time: 'vor 8 Min' }
            ]
        };
        
        const notifications = notificationsByEnvironment[this.environment] || notificationsByEnvironment.desk;

        // Inhaltliche Balance: 50/50 zwischen "realistisch/taskish" und "tempting".
        // (Intensität wirkt über Häufigkeit/Stress, nicht über extreme Inhalts-Schieflage.)
        const taskishApps = new Set(['Mail', 'Kalender', 'Moodle', 'Einkaufsliste', 'Banking', 'Payback', 'CampusApp', 'GitHub', 'Maps', 'PayPal', 'REWE']);
        const temptingApps = new Set(['Discord', 'YouTube', 'Instagram', 'TikTok', 'WhatsApp', 'Lieferando', 'Spotify']);

        // "Realistisch" = alles was nicht tempting ist (inkl. neutral wie Anruf)
        const realistic = notifications.filter(n => !temptingApps.has(n.app));
        const tempting = notifications.filter(n => temptingApps.has(n.app));

        let bag = notifications.slice();
        if (realistic.length && tempting.length) {
            bag = (Math.random() < 0.5) ? realistic : tempting;
        }

        // Anti-repeat: gleiche Notification nicht direkt hintereinander (oder in kurzer Zeit)
        let pickBag = bag;
        try {
            const now = Date.now();
            const repeatMin = Math.max(8000, Number(this._phoneNotifRepeatMinMs) || 30000);
            const keyOf = (n) => `${n.app}|${n.sender}|${n.text}`;
            const recentAt = this._recentPhoneNotifAt || (this._recentPhoneNotifAt = new Map());
            const filtered = bag.filter((n) => {
                const lastAt = Number(recentAt.get(keyOf(n)) || 0);
                return !lastAt || (now - lastAt) > repeatMin;
            });
            if (filtered.length) pickBag = filtered;
        } catch (e) {}

        const notif = this.randomChoice(pickBag);

        try {
            const now = Date.now();
            const key = `${notif.app}|${notif.sender}|${notif.text}`;
            const recentAt = this._recentPhoneNotifAt || (this._recentPhoneNotifAt = new Map());
            recentAt.set(key, now);
        } catch (e) {}

        // Mapping: Wenn Nachricht Aufgabenbezug hat, To-Do ergänzen.
        // Wichtig: Tasks sollen sich sichtbar vermehren => pro App mehrere mögliche Todos.
        const todoMappings = [
            // desk
            { env: 'desk', app: 'Discord', text: 'Eine Runde zocken?', todos: ['Mit Freunden zocken', 'Discord beantworten', 'Kurz Discord öffnen'] },
            { env: 'desk', app: 'YouTube', text: 'Neues Video von deinem Lieblingskanal', todos: ['YouTube-Video anschauen', 'YouTube Shorts checken'] },
            { env: 'desk', app: 'Steam', text: 'Download bereit: 47 GB', todos: ['Spiel-Update installieren', 'Steam-Update starten'] },
            { env: 'desk', app: 'Instagram', text: 'hat dein Foto geliked', todos: ['Instagram checken', 'Auf Instagram reagieren'] },
            { env: 'desk', app: 'TikTok', text: '12 neue Videos für dich', todos: ['TikTok durchscrollen', 'TikTok öffnen'] },
            { env: 'desk', app: 'Spotify', text: 'Deine Wochenübersicht ist da', todos: ['Spotify Playlist hören', 'Musik wechseln'] },
            { env: 'desk', app: 'Slack', text: 'Kurzer Ping: hast du kurz Zeit?', todos: ['Auf Slack antworten', 'Slack kurz checken'] },
            { env: 'desk', app: 'Kalender', text: 'Meeting in 30 Minuten', todos: ['Meeting vorbereiten', 'Meeting-Link raussuchen'] },
            { env: 'desk', app: 'Mail', text: 'Reminder: Abgabe heute 23:59', todos: ['Abgabe fertig machen', 'Abgabe checken', 'Letzte Korrektur Abgabe'] },
            { env: 'desk', app: 'GitHub', text: 'Build fehlgeschlagen: Tests rot', todos: ['Build-Fehler fixen', 'Tests reparieren', 'CI Log anschauen'] },
            { env: 'desk', app: 'Lieferando', text: 'Heute 2 für 1 auf Pizza', todos: ['Pizza bestellen', 'Essen planen'] },
            { env: 'desk', app: 'Wetter', text: 'Regen in 20 Minuten', todos: ['Fenster schließen', 'Jacke bereitlegen'] },
            // hoersaal
            { env: 'hoersaal', app: 'Mail', text: 'Klausurtermin verschoben', todos: ['Klausurtermin notieren', 'Klausurplanung anpassen'] },
            { env: 'hoersaal', app: 'WhatsApp', text: 'Kommst du heute zum Lernen?', todos: ['Lerngruppe besuchen', 'Auf WhatsApp antworten'] },
            { env: 'hoersaal', app: 'Kalender', text: 'Abgabe Hausarbeit in 2 Tagen', todos: ['Hausarbeit abgeben', 'Hausarbeit finalisieren'] },
            { env: 'hoersaal', app: 'Moodle', text: 'Übungsblatt 7 hochgeladen', todos: ['Übungsblatt 7 bearbeiten', 'Moodle checken'] },
            { env: 'hoersaal', app: 'CampusApp', text: 'Raumänderung: Hörsaal B statt A', todos: ['Raumwechsel merken', 'Zum neuen Raum gehen'] },
            { env: 'hoersaal', app: 'Telegram', text: 'Hat jemand die Folien?', todos: ['Folien organisieren', 'Im Kurschat fragen'] },
            { env: 'hoersaal', app: 'Teams', text: 'Feedback zu Abgabe erhalten', todos: ['Feedback lesen', 'Feedback umsetzen'] },
            { env: 'hoersaal', app: 'Anruf', text: 'Eingehender Anruf...', todos: ['Anruf beantworten', 'Anruf wegdrücken'] },
            // supermarkt
            // "Einkaufsliste abarbeiten" ist im Supermarkt bereits Default-Task.
            // Daher ein konkreter Folgetask, damit die Phone->To-Do Injektion sichtbar bleibt.
            { env: 'supermarkt', app: 'Einkaufsliste', text: 'Noch 3 Artikel übrig', todos: ['Restliche 3 Artikel finden', 'Einkaufsliste weiter abarbeiten'] },
            { env: 'supermarkt', app: 'Payback', text: '20% auf Getränke heute!', todos: ['Getränke kaufen', 'Payback-Angebot nutzen'] },
            { env: 'supermarkt', app: 'WhatsApp', text: 'Vergiss die Milch nicht!', todos: ['Milch kaufen', 'Auf WhatsApp antworten'] },
            { env: 'supermarkt', app: 'Banking', text: 'Abbuchung: -47,23€', todos: ['Kontostand prüfen', 'Ausgaben checken'] },
            { env: 'supermarkt', app: 'Lieferando', text: 'Pizza bestellen & sparen', todos: ['Pizza bestellen', 'Abendessen planen'] },
            { env: 'supermarkt', app: 'Anruf', text: 'Eingehender Anruf...', todos: ['Anruf beantworten', 'Später zurückrufen'] },
            { env: 'supermarkt', app: 'REWE', text: 'Coupon verfügbar: -10% auf Obst', todos: ['Obst kaufen', 'Coupon aktivieren'] },
            { env: 'supermarkt', app: 'Maps', text: 'Parkzeit läuft bald ab', todos: ['Parkzeit prüfen', 'Parkticket verlängern'] },
            { env: 'supermarkt', app: 'PayPal', text: 'Neue Anmeldung erkannt', todos: ['PayPal checken', 'Passwort ändern'] },
            { env: 'supermarkt', app: 'WhatsApp', text: 'Bringst du Chips mit?', todos: ['Chips kaufen', 'Snack-Regal checken'] },
            { env: 'supermarkt', app: 'Kalender', text: 'Arzttermin morgen', todos: ['Arzttermin wahrnehmen', 'Arztunterlagen raussuchen'] },
        ];
        const injectTodo = (baseText) => {
            const base = String(baseText || '').trim();
            if (!base) return false;
            const list = this.taskList || [];
            if (!list.includes(base)) {
                this.addTask(base);
                return true;
            }
            // Falls schon vorhanden: eindeutige Variante hinzufügen, damit die Liste sichtbar wächst.
            for (let i = 2; i <= 9; i++) {
                const alt = `${base} (${i})`;
                if (!list.includes(alt)) {
                    this.addTask(alt);
                    return true;
                }
            }
            return false;
        };

        const match = todoMappings.find(m => m.env === this.environment && m.app === notif.app && (!m.text || notif.text.startsWith(m.text)));
        if (match) {
            const now = Date.now();
            const minTaskMs = Math.max(9000, Number(this._phoneTodoMinMs) || 16000);
            if ((now - (this._lastPhoneTodoAt || 0)) >= minTaskMs) {
                this._lastPhoneTodoAt = now;
                const candidates = Array.isArray(match.todos) ? match.todos : (match.todo ? [match.todo] : []);
                // Nimm das erste Todo, das (noch) nicht existiert, sonst suffixe.
                for (const c of candidates) {
                    if (injectTodo(c)) break;
                }
            }
        }

        // Wir spielen Handyton/Vibration nur, wenn wirklich eine Nachricht angezeigt wird.
        let didDisplayPhoneNotif = false;

        // Desk: Handy liegt auf dem Tisch -> Notification dort anzeigen.
        // User-Wunsch: zusätzlich soll das Handy wieder vor einem erscheinen (wie in den anderen Szenen).
        if (this.environment === 'desk') {
            const deskPhone = document.getElementById('desk-phone');
            const card = document.getElementById('desk-phone__card');
            const appEl = document.getElementById('desk-phone__app');
            const timeEl = document.getElementById('desk-phone__time');
            const senderEl = document.getElementById('desk-phone__sender');
            const textEl = document.getElementById('desk-phone__text');

            if (deskPhone && card && appEl && timeEl && senderEl && textEl) {
                const now = new Date();
                appEl.setAttribute('value', `${notif.icon} ${notif.app}`);
                timeEl.setAttribute('value', notif.time);
                senderEl.setAttribute('value', notif.sender);
                textEl.setAttribute('value', notif.text);

                // Card einblenden
                card.setAttribute('material', 'shader: flat; color:#111827; opacity:0.98; transparent:true');
                didDisplayPhoneNotif = true;

                // Manche Renderer sortieren transparente Flächen "falsch" und übermalen Text.
                // Daher: renderOrder für Card (unten) und Text (oben) setzen.
                setTimeout(() => {
                    try {
                        const setRO = (el, ro) => {
                            if (!el || !el.object3D) return;
                            el.object3D.traverse((o) => { o.renderOrder = ro; });
                        };
                        setRO(card, 998);
                        setRO(appEl, 1000);
                        setRO(timeEl, 1000);
                        setRO(senderEl, 1000);
                        setRO(textEl, 1000);
                    } catch (e) {}
                }, 0);

                // Keine zusätzliche Tisch-Vibration: wir vibrieren das Front-Popup.

                // nach kurzer Zeit wieder ausblenden
                setTimeout(() => {
                    card.setAttribute('material', 'shader: flat; color:#111827; opacity:0.0; transparent:true');
                    appEl.setAttribute('value', '');
                    timeEl.setAttribute('value', '');
                    senderEl.setAttribute('value', '');
                    textEl.setAttribute('value', '');
                }, 3500);
            }
        }
        
        // Telefon-Entity bauen
        const phone = document.createElement('a-entity');
        const startY = -0.7; // Start knapp unter Sichtfeld
        // Desk: etwas höher, damit es nicht "im" Schreibtisch wirkt.
        const endY = (this.environment === 'desk') ? -0.12 : -0.3;

        // Wichtig: Manche Setups/Renderer clippen nahe Objekte aggressiv.
        // Außerdem: falls Animationen nicht laufen, muss es trotzdem sichtbar sein.
        const z = (this.environment === 'desk') ? -1.05 : -0.9;

        // Default: direkt sichtbar platzieren (Animation ist "nice to have").
        phone.setAttribute('position', `0 ${endY} ${z}`);
        phone.setAttribute('rotation', (this.environment === 'desk') ? '-10 0 0' : '-15 0 0');
        // Desk: minimal kleiner, dafür weiter weg -> weniger "clipping" Gefühl.
        phone.setAttribute('scale', (this.environment === 'desk') ? '1.22 1.22 1.22' : '1.35 1.35 1.35');
        
        // iPhone Gehäuse - schwarz und edgy
        const body = document.createElement('a-box');
        body.setAttribute('width', '0.18');
        body.setAttribute('height', '0.38');
        body.setAttribute('depth', '0.015');
        body.setAttribute('color', '#1a1a1a');
        body.setAttribute('material', 'metalness: 0.8; roughness: 0.2');
        phone.appendChild(body);
        
        // Display - der schwarze Bildschirm
        const screen = document.createElement('a-plane');
        screen.setAttribute('width', '0.17');
        screen.setAttribute('height', '0.365');
        screen.setAttribute('position', '0 0 0.009');
        screen.setAttribute('color', '#000000');
        screen.setAttribute('material', 'shader: flat');
        phone.appendChild(screen);
        
        // Die Notch oben (weil Apple halt so ist)
        const notch = document.createElement('a-box');
        notch.setAttribute('width', '0.06');
        notch.setAttribute('height', '0.008');
        notch.setAttribute('depth', '0.005');
        notch.setAttribute('position', '0 0.175 0.012');
        notch.setAttribute('color', '#1a1a1a');
        phone.appendChild(notch);
        
        // Die Benachrichtigungs-Karte (hier kommt die nervige Message)
        const notifCard = document.createElement('a-plane');
        notifCard.setAttribute('width', '0.16');
        notifCard.setAttribute('height', '0.085');
        notifCard.setAttribute('position', '0 0.118 0.011');
        notifCard.setAttribute('color', '#1e293b');
        notifCard.setAttribute('opacity', '0.98');
        notifCard.setAttribute('material', 'shader: flat');
        phone.appendChild(notifCard);
        
        // App-Name mit Icon (links oben in der Notification)
        const appName = document.createElement('a-troika-text');
        appName.setAttribute('value', `${notif.icon} ${notif.app}`);
        appName.setAttribute('position', '-0.073 0.158 0.012');
        appName.setAttribute('max-width', '0.15');
        appName.setAttribute('font-size', '0.014');
        appName.setAttribute('color', '#94a3b8');
        appName.setAttribute('align', 'left');
        appName.setAttribute('anchor', 'left');
        phone.appendChild(appName);
        
        // Zeitstempel (rechts oben)
        const time = document.createElement('a-troika-text');
        time.setAttribute('value', notif.time);
        time.setAttribute('position', '0.068 0.158 0.012');
        time.setAttribute('max-width', '0.15');
        time.setAttribute('font-size', '0.013');
        time.setAttribute('color', '#64748b');
        time.setAttribute('align', 'right');
        time.setAttribute('anchor', 'right');
        phone.appendChild(time);
        
        // Wer hat geschrieben? (dick gedruckt)
        const sender = document.createElement('a-troika-text');
        sender.setAttribute('value', notif.sender);
        sender.setAttribute('position', '-0.073 0.134 0.012');
        sender.setAttribute('max-width', '0.15');
        sender.setAttribute('font-size', '0.016');
        sender.setAttribute('color', '#ffffff');
        sender.setAttribute('align', 'left');
        sender.setAttribute('anchor', 'left');
        phone.appendChild(sender);
        
        // Die eigentliche Nachricht
        const text = document.createElement('a-troika-text');
        text.setAttribute('value', notif.text);
        text.setAttribute('position', '-0.073 0.108 0.012');
        text.setAttribute('max-width', '0.15');
        text.setAttribute('font-size', '0.014');
        text.setAttribute('color', '#cbd5e1');
        text.setAttribute('align', 'left');
        text.setAttribute('anchor', 'left');
        text.setAttribute('baseline', 'top');
        text.setAttribute('line-height', '1.14');
        text.setAttribute('fill-opacity', '0.90');
        phone.appendChild(text);
        
        // Uhrzeit in der Status-Bar (weil Detail!)
        const statusTime = document.createElement('a-troika-text');
        const now = new Date();
        statusTime.setAttribute('value', `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`);
        statusTime.setAttribute('position', '-0.005 0.1785 0.012');
        statusTime.setAttribute('max-width', '0.10');
        statusTime.setAttribute('font-size', '0.013');
        statusTime.setAttribute('color', '#ffffff');
        statusTime.setAttribute('align', 'center');
        statusTime.setAttribute('anchor', 'center');
        phone.appendChild(statusTime);
        
        // Status-Icons
        const statusIcons = document.createElement('a-troika-text');
        statusIcons.setAttribute('value', '📶 🔋');
        statusIcons.setAttribute('position', '0.062 0.1785 0.012');
        statusIcons.setAttribute('max-width', '0.10');
        statusIcons.setAttribute('font-size', '0.013');
        statusIcons.setAttribute('color', '#ffffff');
        statusIcons.setAttribute('align', 'right');
        statusIcons.setAttribute('anchor', 'right');
        phone.appendChild(statusIcons);
        
        // Rein-/Raus-Animation
        // Optionaler Fly-In (wenn Animation-Component verfügbar ist)
        try {
            phone.setAttribute('animation__flyup', {
                property: 'position',
                from: `0 ${startY} ${z}`,
                to: `0 ${endY} ${z}`,
                dur: 650,
                easing: 'easeOutCubic'
            });
        } catch (e) {}
        
        // Vibrations-Animation
        phone.setAttribute('animation__vibrate', {
            property: 'rotation',
            from: '-15 0 -2',
            to: '-15 0 2',
            dur: 100,
            loop: 4,
            dir: 'alternate',
            delay: 500
        });
        
        phone.__adhsPhonePopup = true;
        if (camera) {
            camera.appendChild(phone);
            this.visualDistractions.push(phone);
            didDisplayPhoneNotif = true;

            // Wie beim VR-HUD: sicherstellen, dass das Phone-Popup niemals von Welt-Geometrie verdeckt wird.
            // (Troika-Meshes entstehen async, daher mehrfach anwenden.)
            const applyPhoneOverlayLayering = () => {
                try {
                    if (!phone || !phone.object3D) return;
                    phone.object3D.traverse((o) => {
                        o.renderOrder = 1100;
                        const m = o.material;
                        if (m) {
                            m.depthTest = false;
                            m.depthWrite = false;
                            m.transparent = true;
                        }
                    });
                } catch (e) {}
            };
            setTimeout(applyPhoneOverlayLayering, 0);
            setTimeout(applyPhoneOverlayLayering, 200);
            setTimeout(applyPhoneOverlayLayering, 800);
        }

        // Handyvibration und Notification-Sound nur, wenn wir wirklich etwas angezeigt haben.
        const ctx = this.getAudioContext();
        if (didDisplayPhoneNotif && ctx) {
            this.playPhoneVibrate(ctx);
            this.playNotificationSound(ctx);
        }

        // Interaktiv: Klick aufs Handy = "nachgeben" (Stress/Prokrastination steigen durch Aktion)
        this.makeEntityClickable(phone, { type: 'phone', label: `${notif.app}`, severity: 1.2 });
        
        // Kamera-Shift: Nur wenn keine andere visuelle Ablenkung gerade im Fokus ist
        // (Kein automatischer Kopfmove mehr, sondern gezielter Fokus auf das neue Objekt)
        // Hier: Fokus-Shift NUR wenn keine andere Ablenkung im Zentrum ist
        // (Optional: Fokus-Shift kann auch für andere Typen unten erfolgen)
        
        // Verschwinden
        setTimeout(() => {
            try {
                phone.setAttribute('animation__flydown', {
                    property: 'position',
                    from: `0 ${endY} ${z}`,
                    to: `0 ${startY} ${z}`,
                    dur: 520,
                    easing: 'easeInCubic'
                });
            } catch (e) {}
            
            // Cleanup
            setTimeout(() => {
                if (phone.parentNode) {
                    phone.parentNode.removeChild(phone);
                }
                const index = this.visualDistractions.indexOf(phone);
                if (index > -1) this.visualDistractions.splice(index, 1);
                try { delete phone.__adhsPhonePopup; } catch (e) {}
            }, 700);
        }, 3500);
    }

    // Bewegte Ablenkung im Sichtfeld
    createMovingDistraction() {
        const scene = document.querySelector('a-scene');
        const mover = document.createElement('a-entity');

        // Kurz dimmen (Desk deutlich subtiler)
        if (this.environment === 'desk') {
            this.dimEnvironmentTemporarily(700);
        } else {
            this.dimEnvironmentTemporarily(1500);
        }

        // 50% Chance: Papierflieger statt Standardobjekt
        if (Math.random() < 0.5) {
            // Papierflieger: weißes, längliches Dreieck
            const startX = (Math.random() > 0.5 ? -5 : 5);
            const endX = -startX;
            const y = 1.3 + Math.random() * 1.2;
            const z = -1.2 - Math.random() * 1.5;
            mover.innerHTML = `
                <a-entity id="paperplane"
                    position="${startX} ${y} ${z}"
                    rotation="0 0 0"
                    >
                    <a-cone radius-bottom="0.01" radius-top="0.18" height="0.38" color="#fff" material="opacity:0.93; shader: flat"></a-cone>
                    <a-box width="0.18" height="0.01" depth="0.09" position="0 0.01 -0.09" color="#e5e7eb" material="opacity:0.85; shader: flat"></a-box>
                    <a-animation attribute="position" from="${startX} ${y} ${z}" to="${endX} ${y+0.12} ${z+0.3}"
                        dur="4000" easing="easeInOutQuad"></a-animation>
                    <a-animation attribute="rotation" from="0 0 0" to="0 40 25" dur="4000" easing="easeInOutQuad"></a-animation>
                </a-entity>
            `;
        } else {
            // Standardobjekte wie bisher
            const objects = [
                { shape: 'sphere', color: '#ef4444', size: 0.15, text: '!', light: 3 },
                { shape: 'box', color: '#fbbf24', size: 0.12, text: '⚠️', light: 2.5 },
                { shape: 'sphere', color: '#3b82f6', size: 0.2, text: '💬', light: 3.5 },
            ];
            const obj = this.randomChoice(objects);
            const startX = (Math.random() > 0.5 ? -5 : 5);
            const endX = -startX;
            const y = 1.2 + Math.random() * 1.5;
            const z = -1 - Math.random() * 2;
            mover.innerHTML = `
                <a-${obj.shape} radius="${obj.size}" width="${obj.size}" height="${obj.size}" depth="${obj.size}"
                               color="${obj.color}" 
                               material="emissive: ${obj.color}; emissiveIntensity: 2.0; metalness: 0.3">
                    <a-animation attribute="position" from="${startX} ${y} ${z}" to="${endX} ${y} ${z}" 
                                dur="4000" easing="linear"></a-animation>
                    <a-animation attribute="rotation" from="0 0 0" to="0 360 0" 
                                dur="2000" easing="linear" repeat="2"></a-animation>
                </a-${obj.shape}>
                <a-text value="${obj.text}" position="0 0.3 0" width="3" align="center"></a-text>
                <a-light type="point" intensity="${obj.light}" distance="6" color="${obj.color}">
                    <a-animation attribute="position" from="${startX} ${y} ${z}" to="${endX} ${y} ${z}" 
                                dur="4000" easing="linear"></a-animation>
                </a-light>
            `;
        }

        scene.appendChild(mover);
        this.visualDistractions.push(mover);

        // Desk: keine Zwangsdrehung – nur subtiler Hinweis + räumlicher Sound
        // Andere Umgebungen: wie gehabt
        if (this.environment === 'desk') {
            const cueChanceByLevel = [0, 0.08, 0.14, 0.22];
            const cueChance = cueChanceByLevel[this.distractionLevel] || 0;

            // Grober Hinweis Richtung Zentrum, aber ohne Kopf zu drehen
            if (Math.random() < cueChance) {
                this.createGazeCue(0, 1.9, -1.5, [0, 650, 900, 1100][this.distractionLevel] || 850);
            }

            // Leiser "wer-bewegt-sich-da" Sound (Stereo-Pan abhängig von Seite)
            const pan = (Math.random() > 0.5 ? 1 : -1) * (0.35 + Math.random() * 0.35);
            const ctx = this.getAudioContext();
            if (ctx && this.distractionLevel > 0) {
                this.playSteps(ctx, { volume: 0.12, pan });
            }
        } else {
            // Kein Forced-Look: nur Blickhinweis
            const lookDuration = [0, 900, 1300, 1700][this.distractionLevel];
            if (lookDuration > 0) {
                const midX = 0;
                const y = 2;
                const z = -1.5;
                setTimeout(() => {
                    this.createGazeCue(midX, y, z, lookDuration);
                }, 500);
            }
        }

        // Nach 4.5 Sekunden aufräumen
        this.removeAfter(mover, 4500);
    }

    // Blitzlicht-Ablenkung
    createFlashingLight() {
        // Desk: kein Raum-Strobe. Stattdessen Monitor-Flicker + kurzer Glare (realistischer beim Lernen).
        if (this.environment === 'desk') {
            const levelGlare = [0.0, 0.08, 0.11, 0.14][this.distractionLevel] || 0.1;
            if (this.distractionLevel > 0) {
                this.createCameraGlareFlash(levelGlare, 420 + Math.random() * 280);
                this.createScreenFlicker();
                const extraChanceByLevel = [0, 0.30, 0.55, 0.72];
                if (Math.random() < (extraChanceByLevel[this.distractionLevel] || 0.45)) {
                    setTimeout(() => this.createScreenFlicker(), 180 + Math.random() * 240);
                }
                const ctx = this.getAudioContext();
                if (ctx) {
                    const pan = (Math.random() > 0.5 ? 1 : -1) * (0.15 + Math.random() * 0.25);
                    this.playTinyElectricalTick(ctx, { volume: 0.05 + Math.random() * 0.03, pan });
                }
            }
            return;
        }

        const scene = document.querySelector('a-scene');
        const flash = document.createElement('a-entity');
        
        // Intensität/Dauer pro Level
        const lightIntensities = {
            1: { intensity: 2, duration: 600, repeats: 2, distance: 6 },    // Leicht: subtil
            2: { intensity: 4.5, duration: 800, repeats: 3, distance: 9 },  // Mittel: stärker
            3: { intensity: 6, duration: 1000, repeats: 4, distance: 12 }   // Schwer: sehr stark
        };
        
        const config = lightIntensities[this.distractionLevel] || lightIntensities[1];
        
        // Umgebung kurz dimmen
        this.dimEnvironmentTemporarily(config.duration + 500);
        
        // Zufällige Position
        const x = (Math.random() - 0.5) * 8;
        const y = 1 + Math.random() * 3;
        const z = (Math.random() - 0.5) * 12;
        
        // Farbenpool
        const colors = ['#fbbf24', '#ef4444', '#3b82f6', '#a855f7', '#10b981', '#f97316'];
        const color = colors[Math.floor(Math.random() * colors.length)];
        
        // Nur Lichtquelle
        flash.innerHTML = `
            <a-light type="point" intensity="${config.intensity}" distance="${config.distance}" color="${color}" position="${x} ${y} ${z}">
                <a-animation attribute="intensity" from="${config.intensity}" to="0.3" direction="alternate" dur="${config.duration}" repeat="${config.repeats - 1}"></a-animation>
            </a-light>
        `;
        
        scene.appendChild(flash);
        this.visualDistractions.push(flash);
        
        // Kein Forced-Look: nur Blickhinweis
        const cueDuration = config.duration * config.repeats + 300;
        this.createGazeCue(x, y, z, cueDuration);
        
        // Aufräumen nach Ende
        const cleanupTime = config.duration * config.repeats + 500;
        this.removeAfter(flash, cleanupTime);
    }

    // Periphere Bewegung
    createPeripheralMovement() {
        const scene = document.querySelector('a-scene');
        const peripheral = document.createElement('a-entity');
        
        const side = Math.random() > 0.5 ? 1 : -1;
        const startZ = 3;
        const endZ = -8;
        
        // Grauer Körper
        peripheral.innerHTML = `
            <a-box width="0.4" height="1.6" depth="0.3" color="#4b5563" 
                   position="${side * 4} 0.8 ${startZ}">
                <a-animation attribute="position" 
                            from="${side * 4} 0.8 ${startZ}" 
                            to="${side * 4} 0.8 ${endZ}" 
                            dur="3000" easing="linear"></a-animation>
            </a-box>
        `;
        
        scene.appendChild(peripheral);
        this.visualDistractions.push(peripheral);

        // Desk: keine Zwangsdrehung, stattdessen nur subtile Cues + räumliche Schritte
        if (this.environment === 'desk') {
            const ctx = this.getAudioContext();
            if (ctx && this.distractionLevel > 0) {
                this.playSteps(ctx, { volume: 0.16, pan: side * (0.55 + Math.random() * 0.25) });
            }

            const cueChanceByLevel = [0, 0.10, 0.18, 0.28];
            const cueChance = cueChanceByLevel[this.distractionLevel] || 0;
            if (Math.random() < cueChance) {
                setTimeout(() => {
                    this.createGazeCue(side * 4, 0.8, (startZ + endZ) / 2, [0, 700, 1000, 1300][this.distractionLevel] || 900);
                }, 750);
            }
        } else {
            // Kein Forced-Look: nur Blickhinweis
            const lookDuration = [0, 900, 1300, 1700][this.distractionLevel];
            if (lookDuration > 0) {
                setTimeout(() => {
                    this.createGazeCue(side * 4, 0.8, (startZ + endZ) / 2, lookDuration);
                }, 800);
            }
        }
        
        // Cleanup
        this.removeAfter(peripheral, 3500);
    }

    // Audio-Ablenkungen
    playAudioDistraction() {
        const audioContext = this.getAudioContext();
        if (!audioContext) return;

        // Direkt nach Refocus: absoluter Lock (damit Refocus sofort spürbar ist)
        if (this.isRefocusHardLockActive && this.isRefocusHardLockActive()) return;

        // Hyperfokus: vieles wird ausgeblendet (Audio seltener)
        if (this.isHyperfocusActive()) {
            const skipChanceByLevel = [0, 0.55, 0.62, 0.70];
            if (Math.random() < (skipChanceByLevel[this.distractionLevel] || 0.6)) return;
        }

        // Kurz nach Refocus: Audio-Reize deutlich seltener
        if (this.isRefocusShieldActive && this.isRefocusShieldActive()) {
            const skipChanceByLevel = [0, 0.90, 0.86, 0.80];
            if (Math.random() < (skipChanceByLevel[this.distractionLevel] || 0.85)) return;
        }
        // Kontextspezifische Sounds
        const soundsByEnvironment = {
            desk: [
                { type: 'keyboard', name: 'Tastatur tippen' },
                // Kein notification-Sound mehr hier, da dieser nur mit Handy-Popup kommen soll
                { type: 'phoneVibrate', name: 'Handy vibriert' },
                { type: 'doorSlam', name: 'Haustür knallt' },
                { type: 'steps', name: 'Schritte im Flur' },
                { type: 'pcFan', name: 'PC-Lüfter dreht auf' },
                { type: 'mouseClick', name: 'Maus klicken' },
                { type: 'neighborNoise', name: 'Nachbar bohrt' }
            ],
            hoersaal: [
                { type: 'penClick', name: 'Stift klicken' },
                { type: 'paperRustle', name: 'Papier rascheln' },
                { type: 'cough', name: 'Husten' },
                { type: 'chairCreak', name: 'Stuhl knarzt' },
                { type: 'phoneVibrate', name: 'Handy vibriert' },
                { type: 'whisper', name: 'Flüstern' },
                { type: 'doorSlam', name: 'Tür im Gang' },
                { type: 'steps', name: 'Jemand kommt zu spät' }
            ],
            supermarkt: [
                { type: 'announcement', name: 'Durchsage' },
                { type: 'shoppingCart', name: 'Einkaufswagen rollt' },
                { type: 'cashRegister', name: 'Kasse piept' },
                { type: 'kidCrying', name: 'Kind schreit' },
                { type: 'footsteps', name: 'Viele Leute laufen' },
                { type: 'fridgeHum', name: 'Kühlregal brummt' },
                { type: 'productDrop', name: 'Produkt fällt runter' },
                { type: 'chatter', name: 'Leute reden' }
            ]
        };
        const sounds = soundsByEnvironment[this.environment] || soundsByEnvironment.desk;

        const isReentry = (this.environment === 'desk' && this.taskState === 'working' && this.isReentryActive && this.isReentryActive());

        // Task-State Gewichtung (realistischer: beim Prokrastinieren mehr "tempting" Geraeusche)
        // + Szenen-Charakter: manche Soundtypen sollen je Szene/Level haeufiger sein.
        let bag = sounds.slice();

        try {
            const lvl = Math.max(0, Math.min(3, Number(this.distractionLevel || 0)));
            if (this.environment === 'hoersaal') {
                // Hoersaal: mehr Social/Unruhe
                if (lvl >= 2) bag = bag.concat(
                    { type: 'cough', name: 'Husten' },
                    { type: 'whisper', name: 'Fluestern' }
                );
                if (lvl >= 3) bag = bag.concat(
                    { type: 'chairCreak', name: 'Stuhl knarzt' },
                    { type: 'steps', name: 'Jemand kommt zu spaet' }
                );
            } else if (this.environment === 'supermarkt') {
                // Supermarkt: mehr Crowd/Noise
                if (lvl >= 2) bag = bag.concat(
                    { type: 'shoppingCart', name: 'Einkaufswagen rollt' },
                    { type: 'chatter', name: 'Leute reden' }
                );
                if (lvl >= 3) bag = bag.concat(
                    { type: 'kidCrying', name: 'Kind schreit' },
                    { type: 'cashRegister', name: 'Kasse piept' }
                );
            } else if (this.environment === 'desk') {
                // Desk: mehr kleine Unterbrechungen
                if (lvl >= 2) bag = bag.concat(
                    { type: 'neighborNoise', name: 'Nachbar bohrt' },
                    { type: 'pcFan', name: 'PC-Luefter dreht auf' }
                );
                if (lvl >= 3) bag = bag.concat(
                    { type: 'phoneVibrate', name: 'Handy vibriert' },
                    { type: 'mouseClick', name: 'Maus klicken' }
                );
            }
        } catch (e) {}
        if (this.environment === 'desk') {
            if (this.taskState === 'procrastinating') {
                bag = bag.concat(
                    { type: 'phoneVibrate', name: 'Handy vibriert' },
                    { type: 'mouseClick', name: 'Maus klicken' },
                    { type: 'neighborNoise', name: 'Nachbar bohrt' }
                );
            }
            if (this.taskState === 'working') {
                bag = bag.concat(
                    { type: 'keyboard', name: 'Tastatur tippen' },
                    { type: 'keyboard', name: 'Tastatur tippen' }
                );
            }

            // Re-Entry: weniger "tempting" Audio (Handy/Maus), mehr "Arbeitsgeräusche"
            if (isReentry) {
                bag = bag.filter(s => s.type !== 'phoneVibrate' && s.type !== 'mouseClick');
                bag = bag.concat(
                    { type: 'keyboard', name: 'Tastatur tippen' },
                    { type: 'keyboard', name: 'Tastatur tippen' },
                    { type: 'pcFan', name: 'PC-Lüfter dreht auf' }
                );
            }
        }

        const sound = this.randomChoice(bag);
        console.log(`🔊 Audio-Ablenkung: ${sound.name}`);

        // Habituation: wiederholte Sounds werden ausgeblendet / wirken leiser
        const habFactor = (this.getHabituationFactor ? this.getHabituationFactor('audio', sound.type) : 1.0);
        if (habFactor < 0.55) {
            const skip = 0.18 + 0.22 * (1 - habFactor);
            if (Math.random() < skip) return;
        }

        // Surround/3D: Sound kommt aus einer "Ecke" (kontextbezogen)
        const spatial = (typeof this.getSuggestedSoundSpatial === 'function')
            ? this.getSuggestedSoundSpatial(sound.type)
            : { pan: 0, pos: null };
        const pan = typeof spatial.pan === 'number' ? spatial.pan : 0;
        const pos = spatial.pos || null;
        const vol0 = typeof spatial.volume === 'number' ? spatial.volume : undefined;
        const vol = (typeof vol0 === 'number') ? (vol0 * habFactor) : undefined;

        if (this.noteStimulus) this.noteStimulus('audio', sound.type);

        // Sound abspielen
        switch(sound.type) {
            case 'penClick':
                this.playPenClick(audioContext, { pos, pan, volume: vol });
                break;
            case 'keyboard':
                this.playKeyboardTyping(audioContext, { pos, pan, volume: vol });
                break;
            case 'phoneVibrate':
                this.playPhoneVibrate(audioContext, { pos, pan, volume: vol });
                break;
            case 'cough':
                this.playCough(audioContext, { pos, pan, volume: vol });
                break;
            case 'chairCreak':
                this.playChairCreak(audioContext, { pos, pan, volume: vol });
                break;
            case 'doorSlam':
                this.playDoorSlam(audioContext, { pos, pan, volume: vol });
                break;
            case 'steps':
                this.playSteps(audioContext, { pos, pan, volume: vol });
                break;
            // Neue Sounds für Schreibtisch
            case 'pcFan':
                this.playPCFan(audioContext, { pos, pan, volume: vol });
                break;
            case 'mouseClick':
                this.playMouseClick(audioContext, { pos, pan, volume: vol });
                break;
            case 'neighborNoise':
                this.playNeighborNoise(audioContext, { pos, pan, volume: vol });
                break;
            // Neue Sounds für Hörsaal
            case 'paperRustle':
                this.playPaperRustle(audioContext, { pos, pan, volume: vol });
                break;
            case 'whisper':
                this.playWhisper(audioContext, { pos, pan, volume: vol });
                break;
            // Neue Sounds für Supermarkt
            case 'announcement':
                this.playAnnouncement(audioContext, { pos, pan, volume: vol });
                break;
            case 'shoppingCart':
                this.playShoppingCart(audioContext, { pos, pan, volume: vol });
                break;
            case 'cashRegister':
                this.playCashRegister(audioContext, { pos, pan, volume: vol });
                break;
            case 'kidCrying':
                this.playKidCrying(audioContext, { pos, pan, volume: vol });
                break;
            case 'footsteps':
                this.playFootsteps(audioContext, { pos, pan, volume: vol });
                break;
            case 'fridgeHum':
                this.playFridgeHum(audioContext, { pos, pan, volume: vol });
                break;
            case 'productDrop':
                this.playProductDrop(audioContext, { pos, pan, volume: vol });
                break;
            case 'chatter':
                this.playChatter(audioContext, { pos, pan, volume: vol });
                break;
        }
    }

    // Stift-Klick Sound
    playPenClick(ctx, opts = {}) {
        this.playSoundFile('PencilWrite_S08OF.380.wav', { maxDuration: 0.7, volume: opts.volume ?? 0.20, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Tastatur tippen
    playKeyboardTyping(ctx, opts = {}) {
        this.playSoundFile('CD_MACBOOK PRO LAPTOP KEYBOARD 01_10_08_13.wav', { maxDuration: 1.7, volume: opts.volume ?? 0.22, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Handy vibriert auf dem Tisch (BZZZZZZ)
    playPhoneVibrate(ctx, opts = {}) {
        // Play real phone vibration sound
        this.playSoundFile('cell-phone-vibration-352298.mp3', { maxDuration: 0.9, volume: opts.volume ?? 0.30, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Notification-Sound
    playNotificationSound(ctx, opts = {}) {
        // Wichtig: Smartphone-Notification soll NICHT verlaengert werden.
        this.playSoundFile('MultimediaNotify_S011TE.579.wav', { maxDuration: 0.8, volume: opts.volume ?? 0.26, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Husten (jemand ist krank und du musst es mitbekommen)
    playCough(ctx, opts = {}) {
        this.playSoundFile('horrible-female-cough-66368.mp3', { maxDuration: 1.4, volume: opts.volume ?? 0.30, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Stuhl knarzt (jemand lehnt sich zurück)
    playChairCreak(ctx, opts = {}) {
        this.playSoundFile('Wood_Creaks_01_BTM00499.wav', { maxDuration: 1.0, volume: opts.volume ?? 0.20, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Tür fällt zu - BUMM!
    playDoorSlam(ctx, opts = {}) {
        this.playSoundFile('Wood_Creaks_01_BTM00499.wav', { maxDuration: 0.9, volume: opts.volume ?? 0.32, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Schritte (jemand läuft vorbei)
    playSteps(ctx, opts = {}) {
        this.playSoundFile('WalkWoodFloor_BWU.39.wav', { maxDuration: 1.8, volume: opts.volume ?? 0.22, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // === NEUE SOUNDS FÜR SCHREIBTISCH ===
    
    // PC-Lüfter dreht auf (Gaming PC halt)
    playPCFan(ctx, opts = {}) {
        this.playSoundFile('computer-fan-75947.mp3', { maxDuration: 3.0, volume: opts.volume ?? 0.10, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Maus klicken (zocken nebenbei)
    playMouseClick(ctx, opts = {}) {
        this.playSoundFile('CD_MACBOOK PRO LAPTOP KEYBOARD 01_10_08_13.wav', { maxDuration: 0.28, volume: opts.volume ?? 0.14, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Nachbar bohrt (klassisch)
    playNeighborNoise(ctx, opts = {}) {
        this.playSoundFile('neighborhood-noise-background-33025-320959.mp3', { maxDuration: 2.4, volume: opts.volume ?? 0.20, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // === NEUE SOUNDS FÜR HÖRSAAL ===
    
    // Papier raschelt (jemand blättert)
    playPaperRustle(ctx, opts = {}) {
        this.playSoundFile('SFX,Whispers,Layered,Verb.wav', { maxDuration: 3.2, volume: opts.volume ?? 0.18, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Flüstern (Studierende tuscheln)
    playWhisper(ctx, opts = {}) {
        this.playSoundFile('SFX,Whispers,Layered,Verb.wav', { maxDuration: 3.0, volume: opts.volume ?? 0.17, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // === NEUE SOUNDS FÜR SUPERMARKT ===
    
    // Durchsage (piep-piep)
    playAnnouncement(ctx, opts = {}) {
        // Kein spezielles Durchsage-Sample vorhanden -> wir nutzen den Supermarkt-Ambience-Track kurz als "Durchsage/PA".
        this.playSoundFile('supermarket-17823.mp3', { maxDuration: 2.0, volume: opts.volume ?? 0.14, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Einkaufswagen rollt (metallisches Rumpeln)
    playShoppingCart(ctx, opts = {}) {
        this.playSoundFile('ShoppingCartTurn_S011IN.548.wav', { maxDuration: 1.3, volume: opts.volume ?? 0.24, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Kasse piept (Scanner)
    playCashRegister(ctx, opts = {}) {
        // Scan-Beep: wir verwenden den vorhandenen Notification-Sound als Sample (statt synthetischem Oscillator).
        for (let i = 0; i < 3; i++) {
            setTimeout(() => {
                this.playSoundFile('MultimediaNotify_S011TE.579.wav', { maxDuration: 0.28, volume: opts.volume ?? 0.20, pan: opts.pan ?? 0, pos: opts.pos || null });
            }, i * 520);
        }
    }

    // Kind schreit (hochfrequent)
    playKidCrying(ctx, opts = {}) {
        this.playSoundFile('baby-crying-463213.mp3', { maxDuration: 1.8, volume: opts.volume ?? 0.30, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Viele Schritte (mehrere Leute)
    playFootsteps(ctx, opts = {}) {
        this.playSoundFile('WalkWoodFloor_BWU.39.wav', { maxDuration: 1.9, volume: opts.volume ?? 0.18, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Kühlregal brummt
    playFridgeHum(ctx, opts = {}) {
        // Kein Fridge-Sample vorhanden -> Fan/Hum Sample verwenden.
        this.playSoundFile('computer-fan-75947.mp3', { maxDuration: 3.5, volume: opts.volume ?? 0.10, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Produkt fällt runter (Klonk!)
    playProductDrop(ctx, opts = {}) {
        // Kein Drop-Sample vorhanden -> Holz-Knacken als plausibler "Klonk".
        this.playSoundFile('Wood_Creaks_01_BTM00499.wav', { maxDuration: 0.6, volume: opts.volume ?? 0.26, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Leute reden (Gemurmel)
    playChatter(ctx, opts = {}) {
        this.playSoundFile('indistinct-deep-male-mumble-14786.mp3', { maxDuration: 1.8, volume: opts.volume ?? 0.12, pan: opts.pan ?? 0, pos: opts.pos || null });
    }

    // Benachrichtigung auf dem rechten Monitor anzeigen (nur im Schreibtisch-Szenario)
    showNotification(opts = {}) {
        if (this._debugNotif) {
            this._notifTickCount = (this._notifTickCount || 0) + 1;
            const badge = this._ensureDebugNotifBadge();
            if (badge) badge.textContent = `notif: ${this._notifTickCount || 0} / popup: ${this._popupCount || 0}`;
        }
        const taskRight = document.querySelector('#task-right');
        if (!taskRight) return;  // Gibt's nur im Schreibtisch

        // Direkt nach Refocus: absoluter Lock (damit Refocus sofort spürbar ist)
        if (this.isRefocusHardLockActive && this.isRefocusHardLockActive()) return;

        // Kurz nach Refocus: weniger "neue" Notifications
        if (this.isRefocusShieldActive && this.isRefocusShieldActive()) {
            const skipChanceByLevel = [0, 0.88, 0.84, 0.78];
            if (Math.random() < (skipChanceByLevel[this.distractionLevel] || 0.83)) return;
        }

        const task = this.getActiveTask ? this.getActiveTask() : { kind: 'misc', text: '' };
        const isProcrastinating = this.taskState === 'procrastinating';
        const isInterrupt = opts && opts.reason === 'interrupt';
        const isReentry = (opts && opts.reason === 'reentry') || (this.taskState === 'working' && this.isReentryActive && this.isReentryActive());
        const isRefocus = opts && opts.reason === 'refocus';
        const lvl = this.distractionLevel || 0;

        // Verhindert Overlap/Flicker: waehrend eine Monitor-Notification sichtbar ist,
        // kommt keine neue nach (sonst konkurrieren mehrere setTimeout-Restore Calls).
        try {
            const now = Date.now();
            const displayMs = 2000;
            const nextAt = Number(this._monitorNotifNextAllowedAt || 0);
            if (now < nextAt) return;
            this._monitorNotifNextAllowedAt = now + displayMs + 120; // kleiner Puffer
        } catch (e) {}

        const base = [
            'Akku bei 20%',
            'WLAN instabil',
            'Update verfügbar',
            'Speicher fast voll',
            'Bluetooth an',
            'Kalender: in 1 Stunde',
            'Neue Geräte in der Nähe'
        ];

        const taskish = (task.kind === 'deepwork')
            ? [
                'Build: 1 Warnung',
                'PR Kommentar: „kurz schauen?“',
                'Docs Tab: „nur schnell…“',
                'TODO: 3 offene Punkte',
                'Lint: 2 Fehler',
                'Branch: Konflikt erkannt'
            ]
            : (task.kind === 'email')
                ? [
                    'E-Mail erhalten',
                    'Kalender-Erinnerung',
                    'Slack: @du',
                    'Outlook: 2 neue Mails',
                    'Teams: Mention',
                    'Anhang fehlt?'
                ]
                : (task.kind === 'planning')
                    ? [
                        'Notizen: 3 neue Punkte',
                        'Preisvergleich offen',
                        'Liste: noch 5 Schritte',
                        'Plan: „nur anfangen“'
                    ]
                    : ['Erinnerung: „kurz erledigen“', 'Tab: „nur kurz nachsehen“'];

        const tempting = [
            'YouTube Empfehlung',
            'Discord: neue Nachricht',
            'Steam: Update (jetzt?)',
            'Social: 2 neue Nachrichten',
            'TikTok: Für dich',
            'Instagram: neue Story',
            'Reddit: Trending Thread'
        ];

        const reentry = [
            'Zurück zum Tab: „Wo war ich?“',
            'Cursor blinkt… (Kontext?)',
            'Notiz: „Faden wieder aufnehmen“',
            'Scroll: „wo war die Stelle?“',
            'Suchfeld: „was wollte ich?“'
        ];

        const refocus = [
            'Zurück zur Aufgabe',
            'Nächster Schritt: klein anfangen',
            'Mini-Plan: 2 Minuten dranbleiben',
            'Atmen. Ein Satz reicht.',
            'Nur Überschrift schreiben'
        ];

        const notifications = isRefocus
            ? base.concat(taskish, refocus)
            : ((isProcrastinating || isInterrupt)
                ? base.concat(tempting)
                : (isReentry ? base.concat(taskish, reentry) : base.concat(taskish)));

        // Inhaltliche Balance: 50/50 zwischen taskish (realistisch) und tempting,
        // außer in Zuständen, wo es bewusst "zieht" (Prokrastination/Interrupt) oder "stabilisiert" (Refocus).
        let finalBag = notifications.slice();
        if (!isRefocus && !(isProcrastinating || isInterrupt)) {
            finalBag = finalBag.concat(taskish, tempting);
        }
        
        // Random Nachricht auswählen und kurz anzeigen
        const oldValue = taskRight.getAttribute('value');
        // Stable baseline: wenn wir schon eine Notification angezeigt haben, nicht erneut "oldValue" ueberschreiben.
        if (typeof this._monitorNotifBaseValue !== 'string') {
            this._monitorNotifBaseValue = oldValue || '';
        }
        let pickBag = finalBag;
        try {
            const now = Date.now();
            const repeatMin = Math.max(3000, Number(this._monitorNotifRepeatMinMs) || 12000);
            const recentAt = this._recentMonitorNotifAt || (this._recentMonitorNotifAt = new Map());
            const filtered = finalBag.filter((msg) => {
                const key = String(msg || '');
                const lastAt = Number(recentAt.get(key) || 0);
                return !lastAt || (now - lastAt) > repeatMin;
            });
            if (filtered.length) pickBag = filtered;
        } catch (e) {}

        const chosen = this.randomChoice(pickBag);
        taskRight.setAttribute('value', chosen);
        try {
            const now = Date.now();
            const recentAt = this._recentMonitorNotifAt || (this._recentMonitorNotifAt = new Map());
            recentAt.set(String(chosen || ''), now);
        } catch (e) {}
        
        // Nach 2 Sekunden wieder weg (Timer vorher abbrechen, damit nichts "zurueckspringt")
        try {
            if (this._monitorNotifResetTimer) clearTimeout(this._monitorNotifResetTimer);
        } catch (e) {}
        const token = (this._monitorNotifToken = (Number(this._monitorNotifToken) || 0) + 1);
        this._monitorNotifResetTimer = setTimeout(() => {
            try {
                if (token !== this._monitorNotifToken) return;
                taskRight.setAttribute('value', (typeof this._monitorNotifBaseValue === 'string') ? this._monitorNotifBaseValue : '');
                this._monitorNotifBaseValue = '';
            } catch (e) {}
        }, 2000);
    }

    // Objekte im Raum bewegen (falls welche da sind)
    startMovingObjects(speed) {
        const plant = document.querySelector('#plant');
        if (plant && speed > 0) {
            // Pflanze leicht wackeln lassen (warum? Macht's halt lebendiger!)
            plant.innerHTML += `
                <a-animation attribute="position" 
                            from="${plant.getAttribute('position')}" 
                            to="${plant.getAttribute('position')}" 
                            dur="2000" 
                            direction="alternate" 
                            repeat="indefinite"></a-animation>
            `;
        }
    }

    // Professor (Simlish)
    startProfessorTalking() {
        if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return;
        if (this.professorAudioContext) return; // Läuft schon

        this.professorAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = this.professorAudioContext;

        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }

        // Gain Node für Lautstärke-Kontrolle
        this.professorGain = ctx.createGain();
        this.professorGain.gain.value = 0.18; // Lauter, damit es als Reiz klarer wahrnehmbar ist
        // Positional: Professor vorne im Raum
        const professorPos = this.getWorldPosFromCameraOffset({ x: 0.0, y: 1.2, z: -3.2 });
        const professorOut = this.createSpatialOutput(ctx, { volume: 1.0, pan: 0, pos: professorPos });
        this.professorGain.connect(professorOut);

        // Looping mumble
        this.professorSource = null;
        const playLoop = () => {
            if (!this.professorAudioContext || !this.professorGain) return;
            const path = 'Assets/Textures/sounds/indistinct-deep-male-mumble-14786.mp3';
            fetch(path)
                .then(response => response.arrayBuffer())
                .then(arrayBuffer => ctx.decodeAudioData(arrayBuffer))
                .then(audioBuffer => {
                    if (!this.professorAudioContext || !this.professorGain) return;
                    const source = ctx.createBufferSource();
                    source.buffer = audioBuffer;
                    source.loop = true;
                    source.connect(this.professorGain);
                    source.playbackRate.value = 0.95 + Math.random() * 0.1; // Leicht variieren
                    source.start(ctx.currentTime);
                    this.professorSource = source;
                })
                .catch(err => console.log('Mumble nicht gefunden, fallback auf Simlish'));
        };
        playLoop();
        console.log('👨‍🏫 Professor redet (Loop Mode)');
    }
    
    // Generiert Professor-Rede mit Mumble-Sound
    generateProfessorSpeech(ctx) {
        if (!this.active || !this.professorGain) return;
        
        // Mumble-Sound abspielen
        const path = 'Assets/Textures/sounds/indistinct-deep-male-mumble-14786.mp3';
        
        fetch(path)
            .then(response => response.arrayBuffer())
            .then(arrayBuffer => ctx.decodeAudioData(arrayBuffer))
            .then(audioBuffer => {
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(this.professorGain);
                
                // Zufällige Playback-Rate (Geschwindigkeit variieren)
                source.playbackRate.value = 0.9 + Math.random() * 0.3; // 0.9-1.2x
                
                // Zufälliger Start-Punkt im Audio
                const offset = Math.random() * Math.max(0, audioBuffer.duration - 2);
                const duration = Math.min(0.8 + Math.random() * 0.6, audioBuffer.duration - offset); // 0.8-1.4s
                
                source.start(ctx.currentTime, offset);
                source.stop(ctx.currentTime + duration);
                
                // Nächste Silbe nach Pause
                const pause = 0.3 + Math.random() * 0.7; // 0.3-1.0s Pause
                const longPauseChance = Math.random() < 0.25 ? (0.8 + Math.random() * 1.2) : 0; // Manchmal längere Pause
                
                setTimeout(() => {
                    this.generateProfessorSpeech(ctx);
                }, (duration + pause + longPauseChance) * 1000);
            })
            .catch(err => console.log('Mumble nicht gefunden, fallback auf Simlish'));
    }
    
    // Professor-Audio stoppen
    stopProfessorTalking() {
        if (this.professorSource) {
            try { this.professorSource.stop(); } catch(e) {}
            this.professorSource = null;
        }
        if (this.professorAudioContext) {
            try {
                this.professorAudioContext.close();
            } catch(e) {}
            this.professorAudioContext = null;
            this.professorGain = null;
            console.log('🔇 Professor hört auf zu reden');
        }
    }

    // ALLES AUFRÄUMEN! (wenn Simulation stoppt)
    clearAllDistractions() {
        this.visualDistractions.forEach(element => {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
        });
        this.visualDistractions = [];  // Array leeren
    }

    updateListenerFromCamera(ctx) {
        try {
            if (!ctx || !ctx.listener) return;
            const cam = document.querySelector('a-camera') || document.querySelector('[camera]');
            if (!cam || !cam.object3D) return;
            if (typeof THREE === 'undefined' || !THREE.Vector3) return;

            const pos = new THREE.Vector3();
            cam.object3D.getWorldPosition(pos);

            const forward = new THREE.Vector3();
            cam.object3D.getWorldDirection(forward);

            const quat = new THREE.Quaternion();
            cam.object3D.getWorldQuaternion(quat);
            const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);

            const L = ctx.listener;
            if (L.positionX) {
                L.positionX.value = pos.x;
                L.positionY.value = pos.y;
                L.positionZ.value = pos.z;
            } else if (typeof L.setPosition === 'function') {
                L.setPosition(pos.x, pos.y, pos.z);
            }

            if (L.forwardX) {
                L.forwardX.value = forward.x;
                L.forwardY.value = forward.y;
                L.forwardZ.value = forward.z;
                L.upX.value = up.x;
                L.upY.value = up.y;
                L.upZ.value = up.z;
            } else if (typeof L.setOrientation === 'function') {
                L.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
            }
        } catch (e) {
            // ignore
        }
    }

    // Offset ist im Kamera-Lokalsystem (x: rechts, y: hoch, z: vorne; negatives z ist vor der Kamera)
    getWorldPosFromCameraOffset(offset) {
        try {
            if (typeof THREE === 'undefined' || !THREE.Vector3) return null;
            const cam = document.querySelector('a-camera') || document.querySelector('[camera]');
            if (!cam || !cam.object3D) return null;
            const v = new THREE.Vector3(offset.x || 0, offset.y || 0, offset.z || 0);
            cam.object3D.localToWorld(v);
            return { x: v.x, y: v.y, z: v.z };
        } catch (e) {
            return null;
        }
    }

    // Returns suggested spatial params per environment + sound type.
    getSuggestedSoundSpatial(type) {
        const env = this.environment || 'desk';
        const lvl = this.distractionLevel || 0;

        const j = (v, a) => v + (Math.random() * 2 - 1) * a;
        const mk = (x, y, z, pan, volume) => {
            const pos = this.getWorldPosFromCameraOffset({ x, y, z });
            return { pos, pan, volume };
        };

        if (!type) return { pos: null, pan: 0, volume: undefined };

        if (env === 'desk') {
            switch (type) {
                case 'keyboard':
                    return mk(j(0.15, 0.08), j(-0.10, 0.05), j(-0.55, 0.10), 0.0, 0.22);
                case 'mouseClick':
                    return mk(j(0.35, 0.10), j(-0.12, 0.06), j(-0.55, 0.10), 0.18, 0.18);
                case 'pcFan':
                    return mk(j(-0.55, 0.12), j(-0.05, 0.05), j(-0.95, 0.18), -0.15, 0.14);
                case 'phoneVibrate':
                    return mk(j(0.45, 0.10), j(-0.20, 0.06), j(-0.55, 0.12), 0.25, 0.26);
                case 'doorSlam':
                    return mk(j(1.10, 0.20), j(0.15, 0.08), j(1.60, 0.25), 0.65, 0.26);
                case 'steps':
                    return mk(j(-1.10, 0.22), j(0.00, 0.05), j(1.20, 0.25), -0.55, 0.20);
                case 'neighborNoise':
                    return mk(j(-1.25, 0.25), j(0.10, 0.06), j(0.80, 0.25), -0.60, 0.18);
            }
        }

        if (env === 'hoersaal') {
            const seatSide = Math.random() > 0.5 ? 1 : -1;
            const seatX = seatSide * (0.9 + Math.random() * 0.8);
            const seatZ = j(0.6, 0.5);
            switch (type) {
                case 'penClick':
                    return mk(j(seatX, 0.15), j(-0.05, 0.08), j(seatZ, 0.25), seatSide * 0.35, 0.20);
                case 'paperRustle':
                    return mk(j(seatX, 0.18), j(-0.02, 0.08), j(seatZ, 0.30), seatSide * 0.25, 0.18);
                case 'whisper':
                    return mk(j(-1.2, 0.35), j(0.10, 0.10), j(1.3, 0.40), -0.45, 0.16);
                case 'cough':
                    return mk(j(seatX, 0.22), j(0.05, 0.08), j(seatZ, 0.25), seatSide * 0.30, 0.22);
                case 'chairCreak':
                    return mk(j(seatX, 0.20), j(-0.10, 0.08), j(seatZ, 0.25), seatSide * 0.22, 0.18);
                case 'doorSlam':
                    return mk(j(0.0, 0.35), j(0.15, 0.10), j(2.0, 0.35), 0.0, 0.22);
                case 'steps':
                    return mk(j(0.8, 0.35), j(0.00, 0.08), j(2.2, 0.40), 0.35, 0.18);
                case 'phoneVibrate':
                    return mk(j(0.55, 0.18), j(-0.15, 0.06), j(-0.60, 0.15), 0.20, 0.22);
            }
        }

        if (env === 'supermarkt') {
            switch (type) {
                case 'announcement':
                    return mk(j(0.0, 0.20), j(1.35, 0.20), j(-2.6, 0.45), 0.0, 0.16);
                case 'shoppingCart':
                    return mk(j(-1.2, 0.35), j(0.00, 0.08), j(-1.4, 0.35), -0.40, 0.20);
                case 'cashRegister':
                    return mk(j(1.6, 0.45), j(0.10, 0.10), j(-2.4, 0.55), 0.55, 0.20);
                case 'kidCrying':
                    return mk(j(1.2, 0.35), j(0.10, 0.10), j(-1.2, 0.35), 0.45, 0.20);
                case 'footsteps':
                    return mk(j(-0.6, 0.40), j(0.00, 0.08), j(1.8, 0.45), -0.20, 0.16);
                case 'fridgeHum':
                    return mk(j(-2.2, 0.40), j(-0.05, 0.08), j(-1.6, 0.40), -0.65, 0.12);
                case 'productDrop':
                    return mk(j(1.0, 0.40), j(-0.10, 0.06), j(-0.9, 0.35), 0.35, 0.22);
                case 'chatter':
                    return mk(j(-0.2, 0.60), j(0.30, 0.20), j(-2.0, 0.55), 0.0, 0.14);
            }
        }

        const width = lvl === 3 ? 0.6 : (lvl === 2 ? 0.45 : 0.30);
        const fallbackPan = (Math.random() * 2 - 1) * width;
        return { pos: null, pan: fallbackPan, volume: undefined };
    }

    // Externe Sound-Datei laden und abspielen (mit Zeitlimit)
    createSpatialOutput(ctx, opts = {}) {
        const baseVolume = typeof opts.volume === 'number' ? opts.volume : 0.6;
        const volume = Math.min(1.0, baseVolume * (this._volumeBoost || 1.0));
        const pan = typeof opts.pan === 'number' ? Math.max(-1, Math.min(1, opts.pan)) : 0;
        const pos = (opts && opts.pos && typeof opts.pos.x === 'number') ? opts.pos : null;

        const outGain = ctx.createGain();
        outGain.gain.value = volume;

        // True 3D positional audio when we have a world-space position.
        if (pos && typeof ctx.createPanner === 'function') {
            this.updateListenerFromCamera(ctx);
            const panner = ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 0.8;
            panner.maxDistance = 12;
            panner.rolloffFactor = 1.2;

            if (panner.positionX) {
                panner.positionX.value = pos.x;
                panner.positionY.value = pos.y;
                panner.positionZ.value = pos.z;
            } else {
                panner.setPosition(pos.x, pos.y, pos.z);
            }

            outGain.connect(panner);
            panner.connect(ctx.destination);
            return outGain;
        }

        // Stereo fallback (still gives L/R separation)
        if (typeof ctx.createStereoPanner === 'function') {
            const stereo = ctx.createStereoPanner();
            stereo.pan.value = pan;
            outGain.connect(stereo);
            stereo.connect(ctx.destination);
            return outGain;
        }

        // Last-resort fallback
        if (typeof ctx.createPanner === 'function') {
            const panner = ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'linear';
            panner.refDistance = 1;
            panner.maxDistance = 6;
            panner.rolloffFactor = 1;
            panner.setPosition(pan, 0, 1);
            outGain.connect(panner);
            panner.connect(ctx.destination);
            return outGain;
        }

        outGain.connect(ctx.destination);
        return outGain;
    }

    // Externe Sound-Datei laden und abspielen (mit Zeitlimit)
    // Backward-compatible:
    //   playSoundFile(name, 1.2)
    //   playSoundFile(name, {maxDuration, volume, pan})
    playSoundFile(filename, maxDurationOrOptions = 8.0, maybeOptions = null) {
        const path = `Assets/Textures/sounds/${filename}`;
        const audioCtx = this.getAudioContext();
        if (!audioCtx) return;

        // Defensive: cache may be missing in older saves/partial loads
        if (!this._audioBufferCache) this._audioBufferCache = new Map();

        let opts = {};
        let maxDuration = 8.0;
        if (typeof maxDurationOrOptions === 'object' && maxDurationOrOptions) {
            opts = maxDurationOrOptions;
            maxDuration = typeof opts.maxDuration === 'number' ? opts.maxDuration : 8.0;
        } else {
            maxDuration = typeof maxDurationOrOptions === 'number' ? maxDurationOrOptions : 8.0;
            opts = (typeof maybeOptions === 'object' && maybeOptions) ? maybeOptions : {};
        }

        const playBuffer = (audioBuffer) => {
            try {
                const source = audioCtx.createBufferSource();
                source.buffer = audioBuffer;

                // Leicht lauter machen (global), aber sicher clampen.
                const baseVol = (typeof opts.volume === 'number') ? opts.volume : 0.6;
                const boost = (typeof this._volumeBoost === 'number' && isFinite(this._volumeBoost)) ? this._volumeBoost : 1.0;
                const volume = Math.max(0, Math.min(1.0, baseVol * boost));

                const out = this.createSpatialOutput(audioCtx, {
                    volume,
                    pan: typeof opts.pan === 'number' ? opts.pan : 0,
                    pos: (opts && opts.pos) ? opts.pos : null
                });
                source.connect(out);

                const duration = Math.min(audioBuffer.duration, maxDuration);
                source.start(audioCtx.currentTime);
                source.stop(audioCtx.currentTime + duration);
            } catch (e) {
                // Audio-Fehler dürfen niemals Gameplay/UI kaputt machen.
            }
        };

        const cached = this._audioBufferCache.get(filename);
        if (cached) {
            playBuffer(cached);
            return;
        }

        fetch(path)
            .then(response => response.arrayBuffer())
            .then(arrayBuffer => {
                try {
                    return audioCtx.decodeAudioData(arrayBuffer);
                } catch (e) {
                    return null;
                }
            })
            .then(audioBuffer => {
                if (!audioBuffer) return;
                try { this._audioBufferCache.set(filename, audioBuffer); } catch (e) {}
                playBuffer(audioBuffer);
            })
            .catch(() => {
                // fehlende Dateien ignorieren
            });
    }

}

// In Module-Setups: für Legacy/Debug trotzdem global verfügbar machen.
try {
    if (typeof window !== 'undefined' && typeof window.ADHSSimulation === 'undefined') {
        window.ADHSSimulation = ADHSSimulation;
    }
} catch (e) {}
