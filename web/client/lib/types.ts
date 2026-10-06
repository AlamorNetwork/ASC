export type SessionUser = {
  id?: number | string;
  email?: string | null;
  displayName?: string | null;
  legacy?: boolean;
};

export type SessionPayload = {
  csrf: string;
  user: SessionUser;
};

export type Dossier = {
  id: number;
  topic: string;
  question?: string | null;
  state?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type Message = {
  id?: number;
  role: "user" | "assistant";
  text: string;
  created_at?: string;
};

export type ResearchNode = {
  id: number;
  parent_id?: number | null;
  dossier_id?: number;
  title: string;
  assigned_role?: string | null;
  status?: "pending" | "running" | "paused" | "done" | "completed" | "failed" | string;
  progress_stage?: string | null;
  open_question?: string | null;
  result_json?: string | null;
};

export type Claim = {
  id: number;
  text: string;
  status?: string | null;
  quote?: string | null;
  source_title?: string | null;
  source_url?: string | null;
  verify_reason?: string | null;
  verify_method?: string | null;
};

export type DocumentRecord = {
  id: number;
  filename: string;
  kind?: string;
  mime?: string;
  pages?: number | null;
  read_pages?: number | null;
  extraction?: string | null;
};

export type SourceRecord = {
  id?: number;
  title?: string;
  url?: string;
  source_url?: string;
  source_title?: string;
  status?: string;
};

export type WorkspaceState = {
  dossiers: Dossier[];
  selected: Dossier | null;
  investigation?: {
    id: number;
    question: string;
    state: string;
    rounds?: number;
    costToman?: number;
    costUsd?: number;
    nextLeads?: unknown[];
  } | null;
  documents: DocumentRecord[];
  otherDossierDocuments?: DocumentRecord[];
  pendingUploads?: unknown[];
  researchNodes: ResearchNode[];
  researchLeads?: unknown[];
  sources: SourceRecord[];
  siteCrawls?: unknown[];
  claims: Claim[];
  episodes?: unknown[];
  messages: Message[];
  stats?: Record<string, number>;
  googleOcrReady?: boolean;
};

export type LibraryDocument = {
  id: number;
  dossierId: number;
  dossierTopic: string;
  title: string;
  kind: string;
  pages?: number | null;
  readPages?: number | null;
  charCount?: number;
  overview?: string;
  hasOriginal?: boolean;
};

export type Job = {
  id: string;
  kind?: string;
  state: "running" | "done" | "failed" | "needs_vision" | string;
  stage?: string;
  partial?: string;
  error?: string;
  result?: unknown;
};
