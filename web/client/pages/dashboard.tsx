import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Search, MoreVertical, Database, Clock3, Coins, CheckCircle2, Circle,
  TriangleAlert, CircleHelp, FileText, BookOpen, Bookmark, MapPin,
  Scale, Languages, ScanSearch, Mic, Paperclip, ArrowUp, Sparkles, Network, Square
} from "lucide-react";
import { api, waitForJob } from "../lib/api";
import type { Claim, Job, ResearchNode } from "../lib/types";
import { useWorkspace } from "../contexts/WorkspaceContext";
import styles from "./dashboard.module.css";
import WorkspaceRail from "../components/WorkspaceRail";

const headerImg = "/landing-assets/hero-atlas-1920x1080.jpg";
const evidenceImg = "/landing-assets/workflow-evidence-1200x675.jpg";
const libraryImg = "/landing-assets/feature-source-library-1200x675.jpg";

const roleNames: Record<string, string> = {
  coordinator: "عامل مادر", "source-analyst": "عامل اسناد", "web-researcher": "عامل وب", local: "عامل محلی",
};
const statusNames: Record<string, string> = {
  running: "در حال اجرا", done: "تکمیل", completed: "تکمیل", pending: "در صف", paused: "مکث", failed: "خطا",
};
const roleIcons = [Sparkles, FileText, ScanSearch, Languages, Scale, MapPin, Search];

function claimGroup(claim: Claim) {
  if (claim.status === "verified") return "verified";
  if (claim.status === "disputed") return "disputed";
  if (["found", "unverified", "reviewed"].includes(claim.status || "")) return "reviewed";
  return "open";
}

export default function DashboardPage() {
  const [params] = useSearchParams();
  const fresh = params.get("fresh") === "1";
  const { state, loading, error: stateError, refresh } = useWorkspace();
  const [draft, setDraft] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const selected = fresh ? null : state?.selected || null;
  const nodes = fresh ? [] : state?.researchNodes || [];
  const claims = fresh ? [] : state?.claims || [];
  const sources = fresh ? [] : state?.sources || [];
  const documents = fresh ? [] : state?.documents || [];
  const messages = fresh ? [] : state?.messages || [];
  const latestAssistant = [...messages].reverse().find((item) => item.role === "assistant")?.text;

  useEffect(() => {
    if (fresh) void refresh(null, true).catch(() => undefined);
  }, [fresh, refresh]);

  const grouped = useMemo(() => ({
    verified: claims.filter((item) => claimGroup(item) === "verified"),
    reviewed: claims.filter((item) => claimGroup(item) === "reviewed"),
    disputed: claims.filter((item) => claimGroup(item) === "disputed"),
    open: claims.filter((item) => claimGroup(item) === "open"),
  }), [claims]);
  const completed = nodes.filter((item) => ["done", "completed"].includes(item.status || "")).length;
  const progress = nodes.length ? Math.round(completed / nodes.length * 100) : 0;
  const running = nodes.filter((item) => item.status === "running").length;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || job?.state === "running") return;
    setDraft("");
    setError("");
    try {
      const started = await api<{ id: string }>("/api/chat", { method: "POST", json: { message, dossierId: selected?.id || null } });
      const active: Job = { id: started.id, state: "running", stage: "شروع گفت‌وگو" };
      setJob(active);
      await waitForJob(started.id, setJob);
      setJob(null);
      await refresh();
    } catch (caught) {
      setJob(null);
      setError(caught instanceof Error ? caught.message : "ارسال پیام ناموفق بود.");
      setDraft(message);
    }
  }

  async function stop() {
    await api("/api/stop", { method: "POST", json: {} });
    setJob((current) => current ? { ...current, stage: "درخواست توقف ثبت شد" } : current);
  }

  const claimColumns = [
    { title: "تأییدشده", key: "verified" as const, icon: CheckCircle2 },
    { title: "بررسی‌شده", key: "reviewed" as const, icon: Coins },
    { title: "مورد اختلاف", key: "disputed" as const, icon: TriangleAlert },
    { title: "پرسش‌های باز", key: "open" as const, icon: CircleHelp },
  ];

  return <main className={styles.page} dir="rtl">
    <WorkspaceRail active="mother"/>
    <section className={styles.content}>
      <div className={styles.topSearch}><Search size={17}/><input aria-label="جست‌وجو در نمای فعلی" placeholder="جست‌وجو در نمای فعلی…"/><kbd>ASC</kbd></div>
      {(stateError || error) && <div role="alert">{stateError || error}</div>}
      <div className={styles.layout} aria-busy={loading}>
        <aside className={styles.leftColumn}>
          <section className={styles.panel}>
            <header className={styles.panelTitle}><h2>درخت عامل‌ها</h2><span>{nodes.length.toLocaleString("fa-IR")} نیت</span></header>
            <div className={styles.agentTree}>{nodes.length ? nodes.slice(0, 8).map((node, index) => {
              const Icon = roleIcons[index % roleIcons.length];
              const kind = ["done", "completed"].includes(node.status || "") ? "done" : node.status === "running" ? "active" : "queued";
              return <div className={styles.agentRow} key={node.id}><div className={styles.timeline}><i className={styles[kind]}/>{index < Math.min(nodes.length, 8) - 1 && <b/>}</div><div className={styles.agentInfo}><strong>{roleNames[node.assigned_role || ""] || "عامل پژوهش"}</strong><small>{node.title}</small></div><span className={styles.statusPill}>{statusNames[node.status || ""] || node.status || "در صف"}</span><Icon size={18}/></div>;
            }) : <p>هنوز عاملی برای این پرونده اجرا نشده است.</p>}</div>
          </section>

          <section className={styles.panel}>
            <header className={styles.sourcesHead}><div><Database/><h2>منابع</h2><b>{(sources.length + documents.length).toLocaleString("fa-IR")}</b></div><Link to="/sources">نمایش همه</Link></header>
            <div className={styles.sourceList}>{[...documents.map((item) => ({ id: item.id, title: item.filename, type: item.kind || "سند" })), ...sources.map((item, index) => ({ id: item.id || index, title: item.title || item.source_title || item.url || item.source_url || "منبع", type: item.status || "وب" }))].slice(0, 6).map((source, index) => <article key={`${source.id}-${index}`}>
              <div className={styles.thumb} style={{ backgroundImage: `linear-gradient(180deg,transparent,rgba(3,10,7,.58)),url(${index % 2 ? libraryImg : evidenceImg})` }}/>
              <div><h3>{source.title}</h3><p>{source.type}</p></div><Bookmark size={15}/>
            </article>)}</div>
          </section>
        </aside>

        <section className={styles.main}>
          <header className={styles.projectHeader} style={{ backgroundImage: `linear-gradient(90deg,rgba(3,12,9,.96),rgba(3,12,9,.56)),url(${headerImg})` }}>
            <div className={styles.projectThumb} style={{ backgroundImage: `url(${evidenceImg})` }}/>
            <div className={styles.projectInfo}><div className={styles.breadcrumb}>پرونده‌ها <span>‹</span> {selected?.topic || "پرونده تازه"}</div><div className={styles.titleRow}><h1>{selected?.topic || "گفت‌وگوی تازه"}</h1><span>{job?.state === "running" ? "در حال کار" : selected ? "ذخیره‌شده" : "آمادهٔ شروع"}</span></div><p>{selected?.question || "یک سؤال یا فکر نیمه‌کاره بنویس؛ عامل مادر مسیر مناسب را می‌سازد."}</p>
              <div className={styles.metrics}><span><BookOpen/>{(sources.length + documents.length).toLocaleString("fa-IR")}<small>منبع</small></span><span><FileText/>{claims.length.toLocaleString("fa-IR")}<small>ادعا</small></span><span><Clock3/>{running.toLocaleString("fa-IR")}<small>عامل فعال</small></span><span><Coins/>{Number(state?.investigation?.costToman || 0).toLocaleString("fa-IR")}<small>تومان</small></span></div>
            </div>
            <div className={styles.dateBox}><span>{selected ? `پرونده #${selected.id.toLocaleString("fa-IR")}` : "هنوز ذخیره نشده"}</span><span>{job?.stage || "فضای پژوهش آماده است"}</span><button aria-label="گزینه‌های پرونده"><MoreVertical/></button></div>
          </header>

          <section className={styles.motherCard}>
            <div className={styles.motherVisual} style={{ backgroundImage: `linear-gradient(180deg,transparent,rgba(3,12,9,.82)),url(${libraryImg})` }}/>
            <div className={styles.motherBody}><div className={styles.motherHead}><div><span className={styles.sun}>✹</span><h2>گفت‌وگو با مادر</h2></div><div className={styles.liveState}><i/>عامل مادر<small>{job?.stage || "آمادهٔ پاسخ"}</small></div></div>
              <p>{job?.partial || latestAssistant || "هنوز پاسخی ثبت نشده است. از کادر پایین گفت‌وگو را آغاز کن."}</p>
              <div className={styles.quickActions}>{["خلاصهٔ یافته‌ها را نشان بده", "شواهد مخالف را جدا کن", "پرسش‌های باز را فهرست کن", "منابع اصلی را اولویت‌بندی کن"].map((label) => <button key={label} onClick={() => setDraft(label)}>{label}</button>)}</div>
            </div>
          </section>

          <section className={styles.claimsSection}><header><div><FileText/><h2>ادعاها</h2><span>{claims.length.toLocaleString("fa-IR")}</span></div><Link to="/evidence">نمایش همه</Link></header>
            <div className={styles.claimGrid}>{claimColumns.map((column) => { const Icon = column.icon; const items = grouped[column.key]; return <article key={column.key} className={styles[column.key]}><div className={styles.claimHead}><Icon/><h3>{column.title}</h3><b>{items.length.toLocaleString("fa-IR")}</b></div>{items.slice(0, 3).map((item) => <p key={item.id}><Circle size={8}/>{item.text}</p>)}{!items.length && <p><Circle size={8}/>موردی ثبت نشده است.</p>}</article>; })}</div>
          </section>

          <section className={styles.progressCard}><header><div><Network/><h2>پیشرفت پژوهش</h2></div><b>{progress.toLocaleString("fa-IR")}٪</b></header><div className={styles.progressBar}><i style={{ width: `${progress}%` }}/></div><div className={styles.steps}>{nodes.slice(0, 5).map((node) => <div key={node.id} className={["done", "completed"].includes(node.status || "") ? styles.doneStep : node.status === "running" ? styles.activeStep : ""}>{["done", "completed"].includes(node.status || "") ? <CheckCircle2/> : <Circle/>}<b>{node.title}</b><small>{node.progress_stage || statusNames[node.status || ""] || "در صف"}</small></div>)}</div></section>

          <form className={styles.composer} onSubmit={submit}><Link to="/sources" aria-label="افزودن یا انتخاب منبع"><Paperclip/></Link><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="پیام خود را بنویسید…" aria-label="پیام به عامل مادر"/><button type="button" aria-label="ورودی صوتی در نسخه وب" title="ورودی صوتی از ربات تلگرام در دسترس است"><Mic/></button>{job?.state === "running" ? <button type="button" className={styles.send} onClick={() => void stop()} aria-label="توقف کار"><Square/></button> : <button type="submit" className={styles.send} disabled={!draft.trim()} aria-label="ارسال پیام"><ArrowUp/></button>}</form>
        </section>
      </div>
    </section>
  </main>;
}
