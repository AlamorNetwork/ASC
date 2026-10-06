import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, TriangleAlert, CircleHelp, Filter, ExternalLink, Quote } from "lucide-react";
import WorkspaceShell from "../components/WorkspaceShell";
import { useWorkspace } from "../contexts/WorkspaceContext";
import type { Claim } from "../lib/types";
import styles from "./evidence.module.css";

const definitions = [
  { key: "verified", title: "تأییدشده", icon: CheckCircle2 },
  { key: "reviewed", title: "بررسی‌شده", icon: Clock3 },
  { key: "disputed", title: "مورد اختلاف", icon: TriangleAlert },
  { key: "open", title: "پرسش‌های باز", icon: CircleHelp },
] as const;

function groupOf(claim: Claim): typeof definitions[number]["key"] {
  if (claim.status === "verified") return "verified";
  if (claim.status === "disputed") return "disputed";
  if (["found", "reviewed", "unverified"].includes(claim.status || "")) return "reviewed";
  return "open";
}

function safeUrl(value?: string | null) {
  try { const url = new URL(value || ""); return ["http:", "https:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

export default function EvidencePage() {
  const { state } = useWorkspace();
  const claims = state?.claims || [];
  const [selectedId, setSelectedId] = useState<number | null>(null);
  useEffect(() => { if (!selectedId || !claims.some((item) => item.id === selectedId)) setSelectedId(claims[0]?.id || null); }, [claims, selectedId]);
  const groups = useMemo(() => Object.fromEntries(definitions.map((definition) => [definition.key, claims.filter((claim) => groupOf(claim) === definition.key)])) as Record<typeof definitions[number]["key"], Claim[]>, [claims]);
  const selected = claims.find((item) => item.id === selectedId) || null;
  const selectedGroup = selected ? groupOf(selected) : "open";
  const sourceUrl = safeUrl(selected?.source_url);

  return <WorkspaceShell active="evidence" title="شواهد و ادعاها" subtitle="هر وضعیت بر اساس داده‌ای است که ASC واقعاً ثبت و بررسی کرده است." actions={<button className={styles.filter} disabled><Filter/> فیلترها</button>}>
    <div className={styles.summary}>{definitions.map((definition) => { const Icon = definition.icon; return <div key={definition.key} className={styles[definition.key]}><Icon/><span>{definition.title}</span><b>{groups[definition.key].length.toLocaleString("fa-IR")}</b></div>; })}</div>
    <div className={styles.board}>
      <section className={styles.columns}>{definitions.map((definition) => { const Icon = definition.icon; const items = groups[definition.key]; return <div className={styles.column} key={definition.key}><header className={styles[definition.key]}><Icon/><h3>{definition.title}</h3><b>{items.length.toLocaleString("fa-IR")}</b></header>{items.map((item) => <button key={item.id} onClick={() => setSelectedId(item.id)} className={selectedId === item.id ? styles.claimActive : styles.claim}><p>{item.text}</p><div><span>#{item.id.toLocaleString("fa-IR")}</span><small>{item.source_title || item.source_url || "منبع ثبت نشده"}</small></div></button>)}{!items.length && <p className={styles.empty}>موردی ثبت نشده است.</p>}</div>; })}</section>
      <aside className={styles.inspector}>{selected ? <>
        <div className={styles.inspectorTop}><span className={styles[selectedGroup]}>{definitions.find((item) => item.key === selectedGroup)?.title}</span><h2>{selected.text}</h2><p>{selected.verify_reason || selected.verify_method || "توضیح جداگانه‌ای برای وضعیت این ادعا ثبت نشده است."}</p></div>
        <div className={styles.source}><header><Quote/><b>{selected.quote ? "نقل‌قول ثبت‌شده" : "شاهد متنی ثبت نشده"}</b></header><blockquote dir="auto">{selected.quote || "برای داوری این ادعا باید منبع و عبارت شاهد بررسی شود."}</blockquote><div><span>{selected.source_title || selected.source_url || "منبع نامشخص"}</span>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer"><ExternalLink/> باز کردن</a>}</div></div>
        <div className={styles.checks}><h3>وضعیت بررسی</h3><div><CheckCircle2/><span><b>ادعا ذخیره شده</b><small>این متن در پروندهٔ فعال ثبت شده است.</small></span></div>{selected.quote && <div><CheckCircle2/><span><b>عبارت شاهد موجود است</b><small>وجود عبارت، به‌تنهایی حقیقت تاریخی را اثبات نمی‌کند.</small></span></div>}{(selected.source_title || selected.source_url) && <div><CheckCircle2/><span><b>منبع مشخص است</b><small>{selected.verify_method || "روش بررسی جداگانه ثبت نشده است."}</small></span></div>}</div>
      </> : <p>برای این پرونده هنوز ادعایی ثبت نشده است.</p>}</aside>
    </div>
  </WorkspaceShell>;
}
