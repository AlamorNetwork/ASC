import { useEffect, useMemo, useState } from "react";
import { BrainCircuit, Globe2, BookOpenText, GitBranch, MapPin, Search, Play, Pause, CircleDot } from "lucide-react";
import WorkspaceShell from "../components/WorkspaceShell";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { api, waitForJob } from "../lib/api";
import type { ResearchNode } from "../lib/types";
import styles from "./agents.module.css";

const icons = [BrainCircuit, BookOpenText, Search, Globe2, GitBranch, MapPin];
const statusLabel: Record<string, string> = { running: "در حال اجرا", done: "تکمیل", completed: "تکمیل", pending: "در صف", paused: "مکث", failed: "خطا" };
const roleLabel: Record<string, string> = { coordinator: "هماهنگی و جمع‌بندی", "source-analyst": "تحلیل منابع محلی", "web-researcher": "پژوهش وب", local: "بررسی اسناد" };

export default function AgentsPage() {
  const { state, refresh } = useWorkspace();
  const nodes = state?.researchNodes || [];
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (!selectedId || !nodes.some((item) => item.id === selectedId)) setSelectedId(nodes[0]?.id || null); }, [nodes, selectedId]);
  const selected = nodes.find((item) => item.id === selectedId) || null;
  const roots = useMemo(() => nodes.filter((item) => !item.parent_id), [nodes]);
  const root = selected?.parent_id ? nodes.find((item) => item.id === selected.parent_id) : selected;

  async function run(node: ResearchNode) {
    setBusy(true); setError("");
    try {
      const started = await api<{ id: string }>("/api/research-nodes/run", { method: "POST", json: { nodeId: node.id } });
      await waitForJob(started.id, (job) => setStage(job.stage || "عامل‌ها در حال کارند…"));
      setStage("این دور پژوهش ذخیره شد.");
      await refresh(state?.selected?.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "اجرای عامل‌ها ناموفق بود."); }
    finally { setBusy(false); }
  }

  async function stop() {
    await api("/api/stop", { method: "POST", json: {} });
    setStage("درخواست توقف ثبت شد؛ عامل پس از گام جاری می‌ایستد.");
  }

  return <WorkspaceShell active="agents" title="درخت عامل‌ها" subtitle="هر شاخه یک نیت ذخیره‌شده است؛ وضعیت‌ها مستقیم از پایگاه داده خوانده می‌شوند." actions={<button className={styles.control} disabled={busy} onClick={() => void stop()}><Pause size={14}/> توقف پژوهش</button>}>
    {(stage || error) && <p role={error ? "alert" : "status"}>{error || stage}</p>}
    <div className={styles.layout}>
      <section className={styles.treePanel}><div className={styles.legend}><span><i className={styles.live}/>در حال اجرا</span><span><i className={styles.done}/>تکمیل</span><span><i className={styles.queue}/>در صف یا مکث</span></div>
        {nodes.length ? <div className={styles.tree}>{roots.map((rootNode, rootIndex) => {
          const RootIcon = icons[rootIndex % icons.length];
          const children = nodes.filter((item) => item.parent_id === rootNode.id);
          return <div key={rootNode.id} className={styles.treeGroup}><button className={styles.rootNode} onClick={() => setSelectedId(rootNode.id)}><RootIcon/><div><b>{rootNode.title}</b><small>{roleLabel[rootNode.assigned_role || ""] || "نیت اصلی پژوهش"}</small></div><span>{statusLabel[rootNode.status || ""] || rootNode.status}</span></button>{children.length > 0 && <><div className={styles.branchLine}/><div className={styles.children}>{children.map((node, index) => { const Icon = icons[(rootIndex + index + 1) % icons.length]; return <button key={node.id} onClick={() => setSelectedId(node.id)} className={selectedId === node.id ? styles.nodeActive : styles.node}><div className={styles.nodeIcon}><Icon/></div><div><b>{node.title}</b><small>{roleLabel[node.assigned_role || ""] || node.assigned_role || "عامل پژوهش"}</small></div><span>{statusLabel[node.status || ""] || node.status}</span></button>; })}</div></>}</div>;
        })}</div> : <div className={styles.empty}>هنوز درختی ساخته نشده است. در گفت‌وگو از عامل مادر بخواه موضوعی را پژوهش کند.</div>}
      </section>
      <aside className={styles.detail}>{selected ? <>
        <div className={styles.detailTop}><div className={styles.bigIcon}><BrainCircuit/></div><div><span>AGENT DETAIL</span><h2>{selected.title}</h2><p>{roleLabel[selected.assigned_role || ""] || selected.assigned_role || "عامل پژوهش"}</p></div></div>
        <div className={styles.detailStats}><span><b>{statusLabel[selected.status || ""] || selected.status}</b> وضعیت ثبت‌شده</span><span><b>#{selected.id.toLocaleString("fa-IR")}</b> شناسهٔ نیت</span><span><b>{nodes.filter((item) => item.parent_id === selected.id).length.toLocaleString("fa-IR")}</b> زیرنیت</span></div>
        <div className={styles.taskBox}><header><CircleDot/><b>گام فعلی</b></header><p>{selected.progress_stage || "گام تازه‌ای برای این عامل ثبت نشده است."}</p></div>
        {selected.open_question && <div className={styles.events}><h3>پرسش باز</h3><div><i/><span>{selected.open_question}</span></div></div>}
        <div className={styles.actions}>{root && !root.parent_id && ["pending", "paused", "failed"].includes(root.status || "") && <button disabled={busy} onClick={() => void run(root)}><Play/> ادامهٔ این مسیر</button>}</div>
      </> : <p>یک عامل را انتخاب کن.</p>}</aside>
    </div>
  </WorkspaceShell>;
}
