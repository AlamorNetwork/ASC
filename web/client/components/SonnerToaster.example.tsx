import { Example } from "@floot/examples";
import { toast } from "sonner";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { SonnerToaster } from "./SonnerToaster";
import { Button } from "./Button";

export default function SonnerToasterShowcase() {
  return (
    <>
      <h1>SonnerToaster</h1>
      <p>
        The host that renders toast notifications raised by the{" "}
        <code>toast</code> function from <code>sonner</code>. It is already
        mounted by the global providers, so an app should not render it again.
      </p>

      <h2>Toast variants</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example title="Success">
          <Button
            onClick={() => {
              toast.success("Success Toast", {
                description: "This is a success toast message",
                icon: <CheckCircle2 size={20} />,
                action: { label: "Action", onClick: () => {} },
                cancel: { label: "Cancel", onClick: () => {} },
                closeButton: true,
              });
            }}
          >
            Success
          </Button>
        </Example>

        <Example title="Error">
          <Button
            onClick={() => {
              toast.error("Error Toast", {
                description: "This is an error toast message",
                icon: <AlertCircle size={20} />,
                action: { label: "Action", onClick: () => {} },
                cancel: { label: "Cancel", onClick: () => {} },
                closeButton: true,
              });
            }}
          >
            Error
          </Button>
        </Example>

        <Example title="Warning">
          <Button
            onClick={() => {
              toast.warning("Warning Toast", {
                description: "This is a warning toast message",
                icon: <AlertTriangle size={20} />,
                action: { label: "Action", onClick: () => {} },
                cancel: { label: "Cancel", onClick: () => {} },
                closeButton: true,
              });
            }}
          >
            Warning
          </Button>
        </Example>

        <Example title="Info">
          <Button
            onClick={() => {
              toast.info("Info Toast", {
                description: "This is an info toast message",
                icon: <Info size={20} />,
                action: { label: "Action", onClick: () => {} },
                cancel: { label: "Cancel", onClick: () => {} },
                closeButton: true,
              });
            }}
          >
            Info
          </Button>
        </Example>
      </div>

      <SonnerToaster closeButton={false} />
    </>
  );
}
