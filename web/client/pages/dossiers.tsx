import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, FolderOpen, Database, FileText, Network, Trash2, Search, Archive } from "lucide-react";
import WorkspaceShell from "../components/WorkspaceShell";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { api } from "../lib/api";
import styles from "./dossiers.module.css";

const covers = [
  "/landing-assets/hero-atlas-1920x1080.jpg",
  "/landing-assets/feature-agent-tree-1200x675.jpg",
  "/landing-assets/feature-source-library-1200x675.jpg",
  "/landing-assets/feature-evidence-board-1200x675.jpg",
];

export default function DossiersPage() {
  const navigate = useNavigate();
  const { state, loading, error, selectDossier, refresh } = useWorkspace();
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<number | null>(null);
  const dossiers = state?.dossiers || [];
  const visible = useMemo(() => dossiers.filter((item) => item.topic.toLocaleLowerCase("fa").includes(query.trim().toLocaleLowerCase("fa"))), [dossiers, query]);
  const current = state?.selected;

  async function open(id: number) {
    await selectDossier(id);
    navigate("/dashboard");
  }

  async function remove(id: number, topic: string) {
    if (!window.confirm(`پروندهٔ «${topic}» و داده‌های وابسته حذف شود؟`)) return;
    setDeleting(id);
    try {
      await api("/api/delete-dossier", { method: "POST", json: { dossierId: id, expectedTopic: topic } });
      await refresh();
    } finally { setDeleting(null); }
  }

  return <WorkspaceShell active="dossiers" title="پرونده‌ها" subtitle="هر موضوع پژوهشی یک پرونده مستقل با منابع، گفت‌وگو، عامل‌ها و دفتر پژوهش خودش دارد." actions={<button className={styles.create} onClick={() => navigate("/dashboard?fresh=1")}><Plus/> پرونده جدید</button>}>
    <div className={styles.overview} aria-label="آمار واقعی فضای پژوهش">
      <div><FolderOpen/><span><b>{dossiers.length.toLocaleString("fa-IR")}</b> پرونده</span></div>
      <div><Database/><span><b>{(state?.sources?.length || 0).toLocaleString("fa-IR")}</b> منبع در پرونده فعال</span></div>
      <div><FileText/><span><b>{(state?.claims?.length || 0).toLocaleString("fa-IR")}</b> ادعا در پرونده فعال</span></div>
      <div><Network/><span><b>{(state?.researchNodes?.length || 0).toLocaleString("fa-IR")}</b> نیت پژوهشی فعال</span></div>
    </div>
    <div className={styles.toolbar}><div><button className={styles.active}>همهٔ پرونده‌ها</button></div><label htmlFor="dossier-search"><Search/><input id="dossier-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="جست‌وجوی پرونده‌ها..."/></label></div>
    {error && <p role="alert">{error}</p>}
    {loading && !state ? <p aria-busy="true">در حال خواندن پرونده‌ها…</p> : <div className={styles.grid}>{visible.map((dossier, index) => {
      const isCurrent = current?.id === dossier.id;
      return <article key={dossier.id} className={styles.card}>
        <div className={styles.cover} style={{ backgroundImage: `linear-gradient(180deg,rgba(4,13,10,.12),rgba(4,13,10,.92)),url(${covers[index % covers.length]})` }}>
          <span>D-{dossier.id.toLocaleString("fa-IR")}</span>
          <button aria-label={`حذف پرونده ${dossier.topic}`} disabled={deleting === dossier.id} onClick={() => void remove(dossier.id, dossier.topic)}><Trash2/></button>
        </div>
        <div className={styles.body}><div className={styles.titleLine}><h2>{dossier.topic}</h2><span className={isCurrent ? styles.running : styles.paused}>{isCurrent ? "پروندهٔ فعال" : dossier.state === "closed" ? "بسته" : "آماده"}</span></div>
          <p>{dossier.question || "گفت‌وگو، منابع و مسیر پژوهش این پرونده در پایگاه داده نگه‌داری می‌شود."}</p>
          {isCurrent && <div className={styles.metrics}><span><Database/>{state?.sources.length || 0}<small>منبع</small></span><span><FileText/>{state?.claims.length || 0}<small>ادعا</small></span><span><Network/>{state?.researchNodes.length || 0}<small>نیت</small></span></div>}
          <footer><span>{dossier.updated_at ? new Date(dossier.updated_at).toLocaleDateString("fa-IR") : "ذخیره‌شده"}</span><button className={styles.openButton} onClick={() => void open(dossier.id)}>باز کردن پرونده ←</button></footer>
        </div>
      </article>;
    })}</div>}
    {!loading && !visible.length && <div className={styles.archive}><Archive/><div><b>پرونده‌ای پیدا نشد</b><p>یک پرونده تازه بساز یا عبارت جست‌وجو را تغییر بده.</p></div><button onClick={() => navigate("/dashboard?fresh=1")}>پرونده جدید</button></div>}
  </WorkspaceShell>;
}
