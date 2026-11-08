import { useCallback, useEffect, useRef, useState } from "react";
import { Close } from "./Icons";

/*
 * Animated walkthrough for connecting a Telegram bot. Every step is a little
 * mock of what you see on your phone (or in APEX), played as a short scene.
 * The scene replays each time you land on a step, so people can go back and watch again.
 */

type Line = { from: "me" | "them"; text: React.ReactNode; d: number };

function Chat({ name, sub, initials, lines, children }: { name: string; sub: string; initials: string; lines: Line[]; children?: React.ReactNode }) {
  return (
    <div className="tg-phone">
      <div className="tg-bar">
        <span className="tg-avatar">{initials}</span>
        <span className="tg-who"><b>{name}</b><small>{sub}</small></span>
      </div>
      <div className="tg-chat">
        {lines.map((l, i) => (
          <div key={i} className={`tg-bubble ${l.from}`} style={{ "--d": `${l.d}ms` } as React.CSSProperties}>{l.text}</div>
        ))}
        {children}
      </div>
    </div>
  );
}

const TOKEN = "7412093856:AAH3kq-Zx91LmPq_rT2vYw";

function SceneFind() {
  return (
    <div className="tg-phone">
      <div className="tg-search"><span className="tg-typed" style={{ "--n": 10 } as React.CSSProperties}>@BotFather</span></div>
      <div className="tg-result" style={{ "--d": "1300ms" } as React.CSSProperties}>
        <span className="tg-avatar">BF</span>
        <span className="tg-who"><b>BotFather <i className="tg-check" aria-label="verified">✓</i></b><small>bot · the official one</small></span>
      </div>
      <div className="tg-result ghost" style={{ "--d": "1450ms" } as React.CSSProperties}>
        <span className="tg-avatar dim">BF</span>
        <span className="tg-who"><b>BotFather_Help</b><small>fake, no blue tick</small></span>
      </div>
      <div className="tg-tap" style={{ "--d": "2000ms" } as React.CSSProperties} />
    </div>
  );
}

function SceneCreate() {
  return (
    <Chat name="BotFather" sub="bot" initials="BF" lines={[
      { from: "me", text: "/newbot", d: 200 },
      { from: "them", text: "Alright, a new bot. How are we going to call it?", d: 900 },
      { from: "me", text: "APEX Trades", d: 1700 },
      { from: "them", text: <>Good. Now choose a username. It must end in <code>bot</code>.</>, d: 2400 },
      { from: "me", text: "my_apex_trades_bot", d: 3200 },
    ]} />
  );
}

function SceneToken() {
  return (
    <Chat name="BotFather" sub="bot" initials="BF" lines={[
      { from: "them", text: <>Done! Congratulations on your new bot.<br />Use this token to access the HTTP API:<br /><span className="tg-token">{TOKEN}</span><br />Keep your token secure.</>, d: 200 },
    ]}>
      <div className="tg-copied" style={{ "--d": "1500ms" } as React.CSSProperties}>Copied</div>
    </Chat>
  );
}

function ScenePaste() {
  return (
    <div className="tg-apex">
      <div className="tg-apex-head"><b>Telegram</b><span className="notify-dot">Not connected</span></div>
      <div className="tg-field">
        <span>Bot token</span>
        <span className="tg-input"><span className="tg-dots" style={{ "--d": "500ms" } as React.CSSProperties}>••••••••••••••••••••••</span></span>
      </div>
      <div className="tg-apex-row">
        <span className="tg-btn press" style={{ "--d": "1500ms" } as React.CSSProperties}>Connect</span>
      </div>
      <div className="tg-apex-ok" style={{ "--d": "2100ms" } as React.CSSProperties}><span className="notify-dot good">Connected to @my_apex_trades_bot</span></div>
    </div>
  );
}

function SceneStart() {
  return (
    <Chat name="APEX Trades" sub="bot" initials="AT" lines={[
      { from: "me", text: "/start", d: 500 },
    ]}>
      <p className="tg-sys" style={{ "--d": "1200ms" } as React.CSSProperties}>Want it in a group instead? Add the bot to the group and send any message there.</p>
    </Chat>
  );
}

function ScenePick() {
  return (
    <div className="tg-apex">
      <p className="hint">Where should APEX send messages?</p>
      <div className="tg-chats">
        <span className="tg-btn pick" style={{ "--d": "700ms" } as React.CSSProperties}>You (private chat)</span>
        <span className="tg-btn">Trading lads (group)</span>
      </div>
      <div className="tg-notif" style={{ "--d": "1700ms" } as React.CSSProperties}>
        <span className="tg-avatar">AT</span>
        <span className="tg-notif-body"><b>APEX Trades</b><span>Big win on BTC/USD <em>+$1,240.00 (+1.2%)</em></span></span>
      </div>
    </div>
  );
}

const STEPS: { title: string; body: React.ReactNode; Scene: () => JSX.Element }[] = [
  { title: "Find BotFather", body: <>Open Telegram and search for <b>@BotFather</b>. Pick the one with the blue tick, that's Telegram's own bot for making bots.</>, Scene: SceneFind },
  { title: "Make your bot", body: <>Send <code>/newbot</code>. Give it any name you like, then a username that ends in <code>bot</code>. It's your own bot, nobody else can use it.</>, Scene: SceneCreate },
  { title: "Copy the token", body: <>BotFather sends you a long token. Tap it to copy. Treat it like a password: anyone with it can send messages as your bot.</>, Scene: SceneToken },
  { title: "Paste it into APEX", body: <>Paste the token into <b>Bot token</b> below and press <b>Connect</b>. It's saved on this computer only and never shown again.</>, Scene: ScenePaste },
  { title: "Say hi to your bot", body: <>Open your new bot in Telegram and press <b>Start</b> (or send <code>/start</code>). Bots can't message you until you do this once.</>, Scene: SceneStart },
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
