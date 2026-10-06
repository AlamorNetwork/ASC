import type { ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import { Link } from "react-router-dom";
import { useWorkspace } from "../contexts/WorkspaceContext";
import WorkspaceRail, { type WorkspaceNavKey } from "./WorkspaceRail";
import styles from "./WorkspaceShell.module.css";

export default function WorkspaceShell({active,children,title,subtitle,actions}:{active:WorkspaceNavKey;children:ReactNode;title:string;subtitle?:string;actions?:ReactNode}){
  const { state } = useWorkspace();
  return <main className={styles.page} dir="rtl">
    <WorkspaceRail active={active}/>
    <section className={styles.content}>
      <header className={styles.top}>
        <div className={styles.heading}><span>ASC WORKSPACE</span><h1>{title}</h1>{subtitle&&<p>{subtitle}</p>}</div>
        <div className={styles.topRight}>
          <Link className={styles.search} to="/dossiers"><FolderOpen size={16}/><span>{state?.selected?.topic || "انتخاب پرونده"}</span></Link>
          {actions}
        </div>
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  </main>
}
