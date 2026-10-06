import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, Link2, FileText, Bookmark, Search, MoreHorizontal, ExternalLink, ScanText, Sparkles } from "lucide-react";
import WorkspaceShell from "../components/WorkspaceShell";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { api, waitForJob } from "../lib/api";
import type { LibraryDocument } from "../lib/types";
import styles from "./sources.module.css";

const covers = [
  "/landing-assets/feature-source-library-1200x675.jpg",
  "/landing-assets/workflow-capture-1200x675.jpg",
  "/landing-assets/workflow-evidence-1200x675.jpg",
];

type Passage = { seq: number; page?: number | null; text: string };

export default function SourcesPage() {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const { state, selectDossier, refresh: refreshWorkspace } = useWorkspace();
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [passages, setPassages] = useState<Passage[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function loadLibrary() {
    const result = await api<{ documents: LibraryDocument[] }>("/api/library");
    setDocuments(result.documents || []);
    setSelectedId((current) => current && result.documents.some((item) => item.id === current) ? current : result.documents[0]?.id || null);
  }

  useEffect(() => { void loadLibrary().catch((caught) => setError(caught.message)); }, []);
  const filtered = useMemo(() => documents.filter((item) => `${item.title} ${item.dossierTopic} ${item.overview || ""}`.toLocaleLowerCase("fa").includes(query.trim().toLocaleLowerCase("fa"))), [documents, query]);
  const item = documents.find((document) => document.id === selectedId) || null;

  useEffect(() => {
    if (!item) { setPassages([]); return; }
    void api<{ passages: Passage[] }>(`/api/source-passages?documentId=${item.id}`).then((result) => setPassages(result.passages || [])).catch((caught) => setError(caught.message));
  }, [item?.id]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(""); setStatus("در حال بارگذاری فایل…");
    try {
      const target = state?.selected?.id ? `&dossierId=${state.selected.id}` : "&newDossier=1";
      const uploaded = await api<{ id: string; jobId?: string | null }>(`/api/upload?name=${encodeURIComponent(file.name)}${target}`, { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      let jobId = uploaded.jobId || null;
      if (!jobId) {
        const imported = await api<{ id: string }>("/api/import", { method: "POST", json: { uploadId: uploaded.id, dossierId: state?.selected?.id || null } });
        jobId = imported.id;
      }
      await waitForJob(jobId, (job) => setStatus(job.stage || "در حال خواندن فایل…"));
      setStatus("فایل خوانده و در کتابخانه ثبت شد.");
      await Promise.all([loadLibrary(), refreshWorkspace()]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "بارگذاری فایل ناموفق بود."); }
    finally { setBusy(false); event.target.value = ""; }
  }

  async function analyze() {
    if (!item) return;
    setBusy(true); setError("");
    try {
      const started = await api<{ id: string }>("/api/analyze-document", { method: "POST", json: { documentId: item.id } });
      await waitForJob(started.id, (job) => setStatus(job.stage || "تحلیل عمیق سند…"));
      setStatus("تحلیل سند کامل شد.");
      await loadLibrary();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "تحلیل سند ناموفق بود."); }
    finally { setBusy(false); }
  }

  async function discuss() {
    if (!item) return;
    await selectDossier(item.dossierId);
    navigate("/dashboard");
  }

  return <WorkspaceShell active="sources" title="کتابخانه منابع" subtitle="تمام اسناد، کتاب‌ها، صفحات وب و متن‌های OCR شده در یک نمای پژوهشی." actions={<><input ref={fileInput} hidden type="file" accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp" onChange={upload}/><button className={styles.primary} disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={15}/> افزودن منبع</button></>}>
    <div className={styles.stats}><span><b>{documents.length.toLocaleString("fa-IR")}</b> کل منابع</span><span><b>{documents.filter((item) => item.kind === "pdf").length.toLocaleString("fa-IR")}</b> PDF</span><span><b>{documents.filter((item) => item.kind === "image").length.toLocaleString("fa-IR")}</b> تصویر</span><span><b>{documents.filter((item) => item.hasOriginal).length.toLocaleString("fa-IR")}</b> اصل فایل موجود</span><span><b>{documents.reduce((sum, item) => sum + Number(item.readPages || 0), 0).toLocaleString("fa-IR")}</b> صفحه خوانده‌شده</span></div>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    <div className={styles.layout}>
      <section className={styles.listPanel}><div className={styles.toolbar}><div className={styles.filters}><button className={styles.active}>همهٔ منابع</button></div><div className={styles.inlineSearch}><Search/><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="جست‌وجو در منابع" placeholder="عنوان، پرونده یا موضوع…"/></div></div>
        <div className={styles.grid}>{filtered.map((document, index) => <button key={document.id} onClick={() => setSelectedId(document.id)} className={selectedId === document.id ? styles.selectedCard : styles.card}>
          <div className={styles.cover} style={{ backgroundImage: `linear-gradient(180deg,transparent,rgba(3,12,9,.75)),url(${covers[index % covers.length]})` }}><span>{document.kind || "سند"}</span><Bookmark/></div>
          <div className={styles.cardBody}><h3>{document.title}</h3><p>{document.dossierTopic}</p><div><span>{document.pages ? `${document.readPages || 0}/${document.pages} صفحه` : `${document.charCount || 0} نویسه`}</span><small>#{document.id}</small></div></div>
        </button>)}</div>
        {!filtered.length && <p>منبعی با این عبارت پیدا نشد.</p>}
      </section>
      <aside className={styles.detail}>{item ? <>
        <div className={styles.detailImage} style={{ backgroundImage: `url(${covers[item.id % covers.length]})` }}/>
        <div className={styles.detailHead}><div><span>{item.kind}</span><h2>{item.title}</h2><p>{item.dossierTopic}</p></div><button aria-label="گزینه‌های منبع"><MoreHorizontal/></button></div>
        <div className={styles.meta}><span><FileText/> {item.pages ? `${item.readPages || 0} از ${item.pages} صفحه` : `${item.charCount || 0} نویسه`}</span><span><ScanText/> متن ذخیره‌شده قابل جست‌وجو است</span><span><Sparkles/> {item.overview ? "تحلیل اجمالی موجود" : "تحلیل عمیق هنوز ساخته نشده"}</span></div>
        <div className={styles.quote}><b>{item.overview ? "دربارهٔ سند" : "قطعهٔ ذخیره‌شده"}</b><p dir="auto">{item.overview || passages[0]?.text || "برای این سند هنوز متن نمایشی ذخیره نشده است."}</p>{passages[0]?.page && <small>صفحه {passages[0].page.toLocaleString("fa-IR")}</small>}</div>
        <div className={styles.detailActions}>{item.hasOriginal && <a href={`/api/source-file?documentId=${item.id}`} target="_blank" rel="noreferrer"><ExternalLink/> باز کردن منبع</a>}<button onClick={() => void discuss()}><Link2/> گفت‌وگو درباره سند</button><button disabled={busy} onClick={() => void analyze()}><Sparkles/> تحلیل عمیق</button></div>
      </> : <p>یک منبع را انتخاب کن.</p>}</aside>
    </div>
  </WorkspaceShell>;
}
