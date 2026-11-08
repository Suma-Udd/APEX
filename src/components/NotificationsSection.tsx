import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Status = { ok: boolean | null; error: string; at: number | null };
type Settings = {
  telegram: { enabled: boolean; token_set: boolean; chat_id: string; chat_title: string; bot_username: string; big_wins_only: boolean };
  discord: { enabled: boolean; webhook_set: boolean; big_wins_only: boolean };
  events: Record<string, boolean>;
  big_win_usd: number; big_win_pct: number; amounts: "both" | "usd" | "pct"; show_equity: boolean; paper_footer: boolean;
  status: { telegram: Status; discord: Status };
};
type Chat = { id: string; title: string; type: string };

const EVENT_LABELS: [string, string][] = [
  ["close", "Position closed"], ["stop_loss", "Stop loss hit"], ["take_profit", "Take profit hit"], ["big_win", "Big win"],
  ["open", "Position opened"], ["order_fill", "Limit / stop order filled"],
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch notify-switch">
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="knob" /></span>
    </label>
  );
}

export default function NotificationsSection() {
  const [s, setS] = useState<Settings | null>(null);
  const [token, setToken] = useState("");
  const [webhook, setWebhook] = useState("");
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const [usd, setUsd] = useState("");
  const [pct, setPct] = useState("");

  const load = async () => {
    const next = await api<Settings>("/api/notify/settings");
    setS(next); setUsd(String(next.big_win_usd)); setPct(String(next.big_win_pct));
  };
  const loadPreview = async () => {
    try { setPreview((await api<{ big_win: string }>("/api/notify/preview")).big_win); } catch { /* optional */ }
  };
  useEffect(() => { void load().catch((e) => setMsg({ text: errText(e), bad: true })); void loadPreview(); }, []);

  const save = async (body: object, note?: string) => {
    setBusy(true);
    try {
      const next = await api<Settings>("/api/notify/settings", { method: "POST", body: JSON.stringify(body) });
      setS(next); setUsd(String(next.big_win_usd)); setPct(String(next.big_win_pct));
      if (note) setMsg({ text: note });
      void loadPreview();
      return next;
    } catch (e) { setMsg({ text: errText(e), bad: true }); return null; }
    finally { setBusy(false); }
  };

  const detect = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ bot_username: string; chats: Chat[] }>("/api/notify/telegram/detect", { method: "POST" });
      setChats(r.chats);
      await load();
      if (!r.chats.length) setMsg({ text: `Connected to @${r.bot_username}. Now open Telegram, send /start to @${r.bot_username} (or add it to a group), then press Find chats again.` });
    } catch (e) { setMsg({ text: errText(e), bad: true }); }
    finally { setBusy(false); }
  };

  const connect = async () => {
    if (!token.trim()) return;
    const next = await save({ telegram: { token: token.trim() } });
    if (next) { setToken(""); await detect(); }
  };

  const pickChat = async (c: Chat) => {
    const next = await save({ telegram: { chat_id: c.id, chat_title: c.title, enabled: true } }, `Sending to ${c.title}. Try "Send test".`);
    if (next) setChats(null);
  };

  const test = async (channel: "telegram" | "discord") => {
    setBusy(true); setMsg(null);
    try { await api("/api/notify/test", { method: "POST", body: JSON.stringify({ channel }) }); setMsg({ text: "Test sent. Check your " + (channel === "telegram" ? "Telegram" : "Discord") + "." }); }
    catch (e) { setMsg({ text: errText(e), bad: true }); }
    finally { setBusy(false); void load(); }
  };

  if (!s) return <p className="hint">Loading notifications…</p>;
  const tg = s.telegram, dc = s.discord;
  const anyOn = tg.enabled || dc.enabled;

  return (
    <>
      <h3>Notifications</h3>
      <p className="hint">Get your trades on Telegram or Discord while APEX is open. Everything stays on this computer, tokens are never shown again after saving.</p>

      <div className="notify-card">
        <div className="notify-head">
          <b>Telegram</b>
          {tg.enabled && tg.chat_id
            ? <span className={`notify-dot ${s.status.telegram.ok === false ? "bad" : "good"}`}>{s.status.telegram.ok === false ? "Last send failed" : `@${tg.bot_username || "bot"} → ${tg.chat_title || tg.chat_id}`}</span>
            : <span className="notify-dot">{tg.token_set ? "Pick a chat" : "Not connected"}</span>}
        </div>
        {!tg.token_set && (
          <ol className="notify-steps">
            <li>In Telegram, open <b>@BotFather</b> and send <code>/newbot</code>.</li>
            <li>Pick any name. It's your bot, call it whatever you like.</li>
            <li>Copy the token it gives you and paste it here.</li>
          </ol>
        )}
        <div className="form-group stacked">
          <label className="form-row"><span>Bot token</span>
            <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder={tg.token_set ? "Saved" : "123456789:AA…"} />
          </label>
        </div>
        <div className="row end">
          {tg.token_set && <button className="btn" disabled={busy} onClick={() => void save({ telegram: { clear_token: true } }, "Telegram disconnected")}>Disconnect</button>}
          {tg.token_set && <button className="btn" disabled={busy} onClick={() => void detect()}>Find chats</button>}
          <button className="btn primary" disabled={busy || !token.trim()} onClick={() => void connect()}>{tg.token_set ? "Replace token" : "Connect"}</button>
        </div>
        {chats && chats.length > 0 && (
          <div className="notify-chats">
            <p className="hint">Where should APEX send messages?</p>
            {chats.map((c) => (
              <button key={c.id} className={`btn ${c.id === tg.chat_id ? "primary" : ""}`} onClick={() => void pickChat(c)} disabled={busy}>
                {c.title}<span className="muted">{c.type === "private" ? " · you" : c.type === "channel" ? " · channel" : " · group"}</span>
              </button>
            ))}
          </div>
        )}
        {tg.token_set && tg.chat_id && (
          <>
            <Switch label="Send to Telegram" checked={tg.enabled} onChange={(v) => void save({ telegram: { enabled: v } })} disabled={busy} />
            <Switch label="Only big wins (good for a group chat)" checked={tg.big_wins_only} onChange={(v) => void save({ telegram: { big_wins_only: v } })} disabled={busy} />
            <div className="row end"><button className="btn" disabled={busy} onClick={() => void test("telegram")}>Send test</button></div>
          </>
        )}
        {s.status.telegram.ok === false && <p className="note bad">{s.status.telegram.error}</p>}
      </div>

      <div className="notify-card">
        <div className="notify-head">
          <b>Discord</b>
          <span className={`notify-dot ${dc.enabled ? (s.status.discord.ok === false ? "bad" : "good") : ""}`}>{dc.enabled ? (s.status.discord.ok === false ? "Last send failed" : "Connected") : dc.webhook_set ? "Off" : "Not connected"}</span>
        </div>
        {!dc.webhook_set && <p className="hint">In a channel: Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL.</p>}
        <div className="form-group stacked">
          <label className="form-row"><span>Webhook URL</span>
            <input type="password" autoComplete="off" spellCheck={false} value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder={dc.webhook_set ? "Saved" : "https://discord.com/api/webhooks/…"} />
          </label>
        </div>
        <div className="row end">
          {dc.webhook_set && <button className="btn" disabled={busy} onClick={() => void save({ discord: { clear_webhook: true } }, "Discord disconnected")}>Disconnect</button>}
          <button className="btn primary" disabled={busy || !webhook.trim()} onClick={() => void save({ discord: { webhook: webhook.trim(), enabled: true } }, "Discord connected").then((r) => r && setWebhook(""))}>Save</button>
        </div>
        {dc.webhook_set && (
          <>
            <Switch label="Send to Discord" checked={dc.enabled} onChange={(v) => void save({ discord: { enabled: v } })} disabled={busy} />
            <Switch label="Only big wins" checked={dc.big_wins_only} onChange={(v) => void save({ discord: { big_wins_only: v } })} disabled={busy} />
            <div className="row end"><button className="btn" disabled={busy} onClick={() => void test("discord")}>Send test</button></div>
          </>
        )}
        {s.status.discord.ok === false && <p className="note bad">{s.status.discord.error}</p>}
      </div>

      {msg && <p className={`note ${msg.bad ? "bad" : ""}`}>{msg.text}</p>}

      {anyOn && (
        <div className="notify-card">
          <div className="notify-head"><b>What to send</b></div>
          {EVENT_LABELS.map(([key, label]) => (
            <Switch key={key} label={label} checked={!!s.events[key]} onChange={(v) => void save({ events: { [key]: v } })} disabled={busy} />
          ))}
          <p className="hint">Margin close-outs are always sent.</p>
          <div className="form-group stacked">
            <label className="form-row"><span>Big win from $</span>
              <input inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} onBlur={() => Number(usd) !== s.big_win_usd && void save({ big_win_usd: Number(usd) || 0 })} />
            </label>
            <label className="form-row"><span>…or % of account</span>
              <input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} onBlur={() => Number(pct) !== s.big_win_pct && void save({ big_win_pct: Number(pct) || 0 })} />
            </label>
          </div>
          <div className="seg full" role="tablist" aria-label="Amounts">
            {([["both", "$ and %"], ["usd", "$ only"], ["pct", "% only"]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={s.amounts === k} className={s.amounts === k ? "on" : ""} onClick={() => void save({ amounts: k })} disabled={busy}>{l}</button>
            ))}
          </div>
          <Switch label="Show account equity" checked={s.show_equity} onChange={(v) => void save({ show_equity: v })} disabled={busy} />
          <Switch label={`Add "paper trading" footer`} checked={s.paper_footer} onChange={(v) => void save({ paper_footer: v })} disabled={busy} />
          {preview && <pre className="notify-preview" aria-label="Preview of a big win message">{preview}</pre>}
        </div>
      )}
    </>
  );
}
