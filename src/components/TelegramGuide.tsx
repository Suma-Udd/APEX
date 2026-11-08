import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isMac } from "../lib/api";
import { Close } from "./Icons";

/*
 * Animated walkthrough for connecting a Telegram bot. Each step is a tiny,
 * looping "screen recording" built from real DOM: a clock drives the scene,
 * so bubbles get typed, the other side shows typing dots, and a cursor moves
 * to what you'd tap. Reduced motion skips straight to the finished frame.
 */

const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/** Milliseconds since the scene started. Loops after `total` plus a short hold. */
function useClock(total: number, hold = 2200) {
  const [t, setT] = useState(() => (reduced() ? total : 0));
  useEffect(() => {
    if (reduced()) return;
    let start = performance.now(), raf = 0;
    const tick = (now: number) => {
      let e = now - start;
      if (e > total + hold) { start = now; e = 0; }
      setT(e);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total, hold]);
  return t;
}

// ── Cursor ────────────────────────────────────────────────────────────────
// Moves between elements inside the scene (found by selector), clicks show a ripple.

type Stop = { at: number; sel?: string; x?: number; y?: number; click?: boolean };

function Cursor({ t, path, root }: { t: number; path: Stop[]; root: React.RefObject<HTMLDivElement> }) {
  const [pts, setPts] = useState<{ x: number; y: number }[]>([]);
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const next: { x: number; y: number }[] = [];
    path.forEach((s, n) => {
      const el = s.sel ? root.current!.querySelector(s.sel) : null;
      if (el) { const r = el.getBoundingClientRect(); next.push({ x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 }); return; }
      // Target not on screen yet: remember where we last saw it, else stay where the cursor already is.
      const prev = next[n - 1] ?? { x: box.width - 20, y: box.height - 20 };
      next.push({ x: s.x ?? (s.sel ? pts[n]?.x : undefined) ?? prev.x, y: s.y ?? (s.sel ? pts[n]?.y : undefined) ?? prev.y });
    });
    if (JSON.stringify(next) !== JSON.stringify(pts)) setPts(next);
  });
  if (!pts.length || t < path[0].at) return null;
  let n = 0;
  while (n < path.length - 1 && t >= path[n + 1].at) n++;
  const a = pts[n], b = pts[Math.min(n + 1, pts.length - 1)];
  const span = n < path.length - 1 ? path[n + 1].at - path[n].at : 1;
  // Travel during the first 70% of each leg, then rest on the target.
  const k = n < path.length - 1 ? ease(Math.min(1, (t - path[n].at) / (span * 0.7))) : 1;
  const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
  const clicked = path.find((s) => s.click && t >= s.at && t < s.at + 380);
  return (
    <div className={`tg-cursor ${clicked ? "down" : ""}`} style={{ transform: `translate(${x}px, ${y}px)` }} aria-hidden="true">
      {clicked && <span key={clicked.at} className="tg-ripple" />}
      <svg width="16" height="20" viewBox="0 0 16 20"><path d="M1 1v15.5l4.2-3.9 2.7 6.1 2.6-1.1-2.7-6h5.7L1 1Z" fill="#fff" stroke="#000" strokeWidth="1.2" strokeLinejoin="round" /></svg>
    </div>
  );
}

// ── Chat ──────────────────────────────────────────────────────────────────

type Msg = { from: "me" | "them"; text: string | React.ReactNode; at: number; typing?: number };

function Ticks({ read }: { read: boolean }) {
  return (
    <svg className={`tg-ticks ${read ? "read" : ""}`} width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
      <path d="M1 5.5 3.8 8.3 9.6 1.7" />{read && <path d="M6.6 8.1 7 8.3l5.8-6.6" />}
    </svg>
  );
}

function Chat({ t, name, initials, msgs, footer, children }: {
  t: number; name: string; initials: string; msgs: Msg[]; footer?: React.ReactNode; children?: React.ReactNode;
}) {
  const typingThem = msgs.find((m) => m.from === "them" && t >= m.at - (m.typing ?? 900) && t < m.at);
  const draft = msgs.find((m) => m.from === "me" && typeof m.text === "string" && t >= m.at - (m.typing ?? 700) && t < m.at);
  const draftText = draft ? (draft.text as string).slice(0, Math.ceil(((t - (draft.at - (draft.typing ?? 700))) / (draft.typing ?? 700)) * (draft.text as string).length)) : "";
  const justSent = msgs.some((m) => m.from === "me" && t >= m.at && t < m.at + 220);
  return (
    <div className="tg-phone">
      <div className="tg-bar">
        <span className="tg-avatar">{initials}</span>
        <span className="tg-who"><b>{name}</b><small className={typingThem ? "typing" : ""}>{typingThem ? "typing…" : "bot"}</small></span>
      </div>
      <div className="tg-chat">
        {msgs.filter((m) => t >= m.at).map((m, n) => (
          <div key={n} className={`tg-bubble ${m.from}`}>
            {m.text}
            {m.from === "me" && <Ticks read={t >= m.at + 600} />}
          </div>
        ))}
        {typingThem && <div className="tg-bubble them tg-typing" aria-label="typing"><i /><i /><i /></div>}
        {children}
      </div>
      {footer ?? (
        <div className="tg-compose">
          <span className={`tg-field-pill ${draftText ? "" : "empty"}`}>{draftText || "Message"}{draft && <span className="tg-caret" />}</span>
          <span className={`tg-send ${draftText ? "on" : ""} ${justSent ? "pop" : ""}`} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 24 24"><path d="M3 11.5 21 3l-8.5 18-2.2-7.3L3 11.5Z" fill="currentColor" /></svg>
          </span>
        </div>
      )}
    </div>
  );
}

function Spinner() { return <span className="tg-spin" aria-hidden="true" />; }

// ── Scenes ────────────────────────────────────────────────────────────────

const TOKEN = "7412093856:AAH3kq-Zx91LmPq_rT2vYw";

function SceneFind() {
  const t = useClock(3200); const root = useRef<HTMLDivElement>(null);
  const q = "BotFather";
  const typed = q.slice(0, Math.max(0, Math.min(q.length, Math.floor((t - 300) / 85))));
  return (
    <div className="tg-scene" ref={root}>
      <div className="tg-phone">
        <div className="tg-search">
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.4" /><path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2.4" /></svg>
          <span className={typed ? "" : "muted"}>{typed ? "@" + typed : "Search"}</span>{t < 1500 && <span className="tg-caret" />}
        </div>
        {t >= 1200 && t < 1450 && <div className="tg-searching"><Spinner /></div>}
        {t >= 1450 && (
          <div className={`tg-result official ${t >= 2500 ? "hl" : ""}`}>
            <span className="tg-avatar">BF</span>
            <span className="tg-who"><b>BotFather <i className="tg-check" aria-label="verified">✓</i></b><small>bot · Telegram's official one</small></span>
          </div>
        )}
        {t >= 1580 && (
          <div className="tg-result ghost">
            <span className="tg-avatar dim">BF</span>
            <span className="tg-who"><b>BotFatherHelp</b><small>no blue tick, skip it</small></span>
          </div>
        )}
      </div>
      <Cursor t={t} root={root} path={[{ at: 1500, x: 270, y: 225 }, { at: 1900, sel: ".tg-result.official .tg-check" }, { at: 2400, sel: ".tg-result.official .tg-check", click: true }]} />
    </div>
  );
}

function SceneCreate() {
  const t = useClock(6400);
  return (
    <div className="tg-scene">
      <Chat t={t} name="BotFather" initials="BF" msgs={[
        { from: "me", text: "/newbot", at: 900, typing: 600 },
        { from: "them", text: "Alright, a new bot. How are we going to call it?", at: 2100, typing: 900 },
        { from: "me", text: "APEX Trades", at: 3400, typing: 800 },
        { from: "them", text: <>Good. Now choose a username. It must end in <code>bot</code>.</>, at: 4600, typing: 900 },
        { from: "me", text: "my_apex_trades_bot", at: 6200, typing: 1100 },
      ]} />
    </div>
  );
}

function SceneToken() {
  const t = useClock(4200); const root = useRef<HTMLDivElement>(null);
  const copied = t >= 2650;
  return (
    <div className="tg-scene" ref={root}>
      <Chat t={t} name="BotFather" initials="BF" msgs={[
        { from: "me", text: "my_apex_trades_bot", at: 0 },
        { from: "them", text: <>Done! Congratulations on your new bot. Use this token to access the HTTP API:<br /><span className={`tg-token ${copied ? "hl" : ""}`}>{TOKEN}</span></>, at: 1300, typing: 1100 },
      ]}>
        {copied && t < 3900 && <div className="tg-copied">Copied to clipboard</div>}
      </Chat>
      <Cursor t={t} root={root} path={[{ at: 1600, x: 270, y: 30 }, { at: 2000, sel: ".tg-token" }, { at: 2550, sel: ".tg-token", click: true }]} />
    </div>
  );
}

function ScenePaste() {
  const t = useClock(4000); const root = useRef<HTMLDivElement>(null);
  const focused = t >= 1000, pasted = t >= 1550, loading = t >= 2500 && t < 3300, done = t >= 3300;
  return (
    <div className="tg-scene" ref={root}>
      <div className="tg-apex">
        <div className="tg-apex-head"><b>Telegram</b><span className={`notify-dot ${done ? "good" : ""}`}>{done ? "Connected" : "Not connected"}</span></div>
        <div className={`tg-field ${focused && !done ? "focus" : ""}`}>
          <span>Bot token</span>
          <span className="tg-input">{pasted ? <span className="tg-dots">••••••••••••••••••••••</span> : <span className="muted">123456789:AA…</span>}{focused && !pasted && <span className="tg-caret" />}</span>
        </div>
        {t >= 1250 && t < 2000 && <div className="tg-keys"><kbd>{isMac ? "⌘" : "Ctrl"}</kbd><kbd>V</kbd></div>}
        <div className="tg-apex-row">
          <span className={`tg-btn primary connect ${t >= 2400 && t < 2650 ? "press" : ""}`}>{loading ? <Spinner /> : done ? "Replace token" : "Connect"}</span>
        </div>
        {done && <div className="tg-apex-ok"><span className="notify-dot good">Connected to @my_apex_trades_bot</span></div>}
      </div>
      <Cursor t={t} root={root} path={[{ at: 300, x: 40, y: 220 }, { at: 700, sel: ".tg-input" }, { at: 1000, sel: ".tg-input", click: true }, { at: 1900, sel: ".connect" }, { at: 2400, sel: ".connect", click: true }]} />
    </div>
  );
}

function SceneStart() {
  const t = useClock(3800); const root = useRef<HTMLDivElement>(null);
  const started = t >= 1700;
  return (
    <div className="tg-scene" ref={root}>
      <Chat t={t} name="APEX Trades" initials="AT"
        msgs={[{ from: "me", text: "/start", at: 1700 }]}
        footer={started ? undefined : <div className="tg-compose"><span className={`tg-start ${t >= 1350 ? "press" : ""}`}>START</span></div>}>
        {!started && <div className="tg-empty"><b>What can this bot do?</b><span>Your own bot. APEX will send your trades here.</span></div>}
        {t >= 2500 && <p className="tg-sys">Want it in a group? Add the bot to the group and send any message there.</p>}
      </Chat>
      <Cursor t={t} root={root} path={[{ at: 400, x: 270, y: 40 }, { at: 800, sel: ".tg-start" }, { at: 1350, sel: ".tg-start", click: true }]} />
    </div>
  );
}

function ScenePick() {
  const t = useClock(5000); const root = useRef<HTMLDivElement>(null);
  const finding = t >= 950 && t < 1700, found = t >= 1700, picked = t >= 2550, tested = t >= 3450;
  return (
    <div className="tg-scene" ref={root}>
      <div className="tg-apex">
        <div className="tg-apex-head"><b>Telegram</b><span className={`notify-dot ${picked ? "good" : ""}`}>{picked ? "@my_apex_trades_bot → You" : "Pick a chat"}</span></div>
        <div className="tg-apex-row">
          {picked
            ? <span className={`tg-btn test ${t >= 3350 && t < 3600 ? "press" : ""}`}>Send test</span>
            : <span className={`tg-btn find ${t >= 850 && t < 1100 ? "press" : ""}`}>{finding ? <Spinner /> : "Find chats"}</span>}
        </div>
        {found && !picked && (
          <div className="tg-chats">
            <span className={`tg-btn you ${t >= 2450 ? "press" : ""}`} style={{ animationDelay: "0ms" }}>You (private chat)</span>
            <span className="tg-btn" style={{ animationDelay: "120ms" }}>Trading lads (group)</span>
          </div>
        )}
        {picked && !tested && <p className="hint tg-fade">Sending to You. Try "Send test".</p>}
      </div>
      {tested && (
        <div className="tg-notif">
          <span className="tg-avatar">AT</span>
          <span className="tg-notif-body"><b>APEX Trades <small>now</small></b><span>Big win on BTC/USD <em>+$1,240.00 (+1.2%)</em></span></span>
        </div>
      )}
      <Cursor t={t} root={root} path={[{ at: 300, x: 40, y: 220 }, { at: 600, sel: ".find" }, { at: 850, sel: ".find", click: true }, { at: 1900, sel: ".you" }, { at: 2450, sel: ".you", click: true }, { at: 2900, sel: ".test" }, { at: 3350, sel: ".test", click: true }]} />
    </div>
  );
}

const STEPS: { title: string; body: React.ReactNode; Scene: () => JSX.Element }[] = [
  { title: "Find BotFather", body: <>Open Telegram and search for <b>@BotFather</b>. Pick the one with the blue tick, that's Telegram's own bot for making bots.</>, Scene: SceneFind },
  { title: "Make your bot", body: <>Send <code>/newbot</code>. Give it any name you like, then a username that ends in <code>bot</code>. It's your own bot, nobody else can use it.</>, Scene: SceneCreate },
  { title: "Copy the token", body: <>BotFather sends you a long token. Tap it to copy. Treat it like a password: anyone with it can send messages as your bot.</>, Scene: SceneToken },
  { title: "Paste it into APEX", body: <>Paste the token into <b>Bot token</b> below and press <b>Connect</b>. It's saved on this computer only and never shown again.</>, Scene: ScenePaste },
  { title: "Say hi to your bot", body: <>Open your new bot in Telegram and press <b>Start</b>. Bots can't message you until you do this once.</>, Scene: SceneStart },
  { title: "Pick the chat", body: <>Back in APEX press <b>Find chats</b>, pick where messages should go, then hit <b>Send test</b>. Turn on <b>Only big wins</b> if it's a group chat.</>, Scene: ScenePick },
];

export default function TelegramGuide({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const [replay, setReplay] = useState(0);
  const nextRef = useRef<HTMLButtonElement>(null);
  const last = i === STEPS.length - 1;

  const go = useCallback((n: number) => {
    if (n < 0 || n >= STEPS.length) return;
    setDir(n > i ? "fwd" : "back"); setI(n); setReplay(0);
  }, [i]);

  useEffect(() => { nextRef.current?.focus(); }, []);
  useEffect(() => {
    // Capture phase so Escape closes only the guide, not the Settings sheet under it.
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); onClose(); }
      else if (e.key === "ArrowRight") go(i + 1);
      else if (e.key === "ArrowLeft") go(i - 1);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [go, i, onClose]);

  const { title, body, Scene } = STEPS[i];

  return (
    <div className="sheet-backdrop guide-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet guide" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <header className="sheet-head">
          <span className="guide-count">Telegram setup · {i + 1} of {STEPS.length}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close guide"><Close size={15} /></button>
        </header>
        <div className="guide-progress" aria-hidden="true"><i style={{ width: `${((i + 1) / STEPS.length) * 100}%` }} /></div>

        <div key={`${i}-${replay}`} className={`guide-step ${dir}`}>
          <div className="guide-stage" onClick={() => setReplay((r) => r + 1)} title="Click to replay"><Scene /></div>
          <h2 id="guide-title">{title}</h2>
          <p className="guide-body">{body}</p>
        </div>

        <div className="guide-foot">
          <div className="guide-dots" role="tablist" aria-label="Steps">
            {STEPS.map((s, n) => (
              <button key={s.title} role="tab" aria-selected={n === i} aria-label={`Step ${n + 1}: ${s.title}`} className={n === i ? "on" : n < i ? "done" : ""} onClick={() => go(n)} />
            ))}
          </div>
          <div className="row end">
            {i > 0 && <button className="btn" onClick={() => go(i - 1)}>Back</button>}
            <button ref={nextRef} className="btn primary" onClick={() => (last ? onClose() : go(i + 1))}>{last ? "Let's do it" : "Next"}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
