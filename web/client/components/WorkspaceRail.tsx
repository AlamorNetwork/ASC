import { Link } from "react-router-dom";
import {
  MessageCircleMore, LibraryBig, Network, FileCheck2, FolderOpen, Settings, LogOut
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../contexts/SessionContext";
import styles from "./WorkspaceRail.module.css";

export type WorkspaceNavKey = "mother" | "sources" | "agents" | "evidence" | "dossiers" | "settings";

const nav = [
  {key:"mother", to:"/dashboard", label:"گفت‌وگو با مادر", icon:MessageCircleMore},
  {key:"sources", to:"/sources", label:"کتابخانه منابع", icon:LibraryBig},
  {key:"agents", to:"/agents", label:"درخت عامل‌ها", icon:Network},
  {key:"evidence", to:"/evidence", label:"شواهد و ادعاها", icon:FileCheck2},
  {key:"dossiers", to:"/dossiers", label:"پرونده‌ها", icon:FolderOpen},
] as const;

export default function WorkspaceRail({active}:{active:WorkspaceNavKey}){
  const navigate = useNavigate();
  const { session, logout } = useSession();
  const displayName = session?.user.displayName || session?.user.email || "پژوهشگر";
  return <aside className={styles.rail} dir="rtl">
    <Link to="/" className={styles.brand}><span>✦</span>ASC</Link>
    <nav>
      {nav.map(item=>{const I=item.icon;return <Link key={item.key} to={item.to} className={active===item.key?styles.active:""}><I/><span>{item.label}</span></Link>})}
    </nav>
    <div className={styles.bottom}>
      <Link to="/settings" className={active==="settings"?styles.activeIcon:""}><Settings/></Link>
      <button className={styles.logout} type="button" aria-label="خروج از حساب" onClick={async()=>{await logout();navigate("/",{replace:true});}}><LogOut/></button>
      <div className={styles.user}><span>{displayName.trim().slice(0,1) || "پ"}</span><small>{displayName}</small></div>
    </div>
  </aside>
}
