import { Example } from "@floot/examples";
import { FileDropzone } from "./FileDropzone";
import { ImageIcon, FileText, Upload, FileArchive } from "lucide-react";

export default function FileDropzoneShowcase() {
  return (
    <>
      <h1>FileDropzone</h1>
      <p>
        A click-or-drop upload target. It validates the dropped files against{" "}
        <code>accept</code>, <code>maxFiles</code> and <code>maxSize</code>, and
        shows a dismissible error when they do not pass.
      </p>

      <h2>Configurations</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
        <Example
          width={520}
          title="Images"
          description="Restricted to JPG and PNG, up to 10MB."
        >
          <FileDropzone
            icon={<ImageIcon size={48} />}
            title="Drop images here"
            subtitle="PNG, JPG up to 10MB"
            accept=".jpg,.jpeg,.png"
            maxSize={10 * 1024 * 1024}
            onFilesSelected={() => {}}
          />
        </Example>

        <Example
          width={520}
          title="Documents"
          description="Restricted to PDF and Word files, up to 25MB."
        >
          <FileDropzone
            icon={<FileText size={48} />}
            title="Drop documents here"
            subtitle="PDF, DOC up to 25MB"
            accept=".pdf,.doc,.docx"
            maxSize={25 * 1024 * 1024}
            onFilesSelected={() => {}}
          />
        </Example>

        <Example
          width={520}
          title="Multiple files"
          description="A maxFiles above one allows a multi-file selection; the title accepts any node."
        >
          <FileDropzone
            maxFiles={5}
            icon={<FileArchive size={48} />}
            title={
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--spacing-xs)",
                }}
              >
                <Upload size={20} />
                Bulk Upload
              </span>
            }
            subtitle="Upload up to 5 files of any type"
            onFilesSelected={() => {}}
          />
        </Example>
      </div>

      <h2>States</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
        <Example
          width={520}
          title="Disabled"
          description="The input is inert and drops are ignored."
        >
          <FileDropzone
            disabled
            title="Disabled State"
            subtitle="This upload zone is inactive"
            onFilesSelected={() => {}}
          />
        </Example>
      </div>
    </>
  );
}
