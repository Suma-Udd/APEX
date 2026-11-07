export type Toast = { id: number; text: string; kind: "info" | "good" | "bad" };

export default function Toasts({ items }: { items: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}><i />{t.text}</div>)}
    </div>
  );
}
