import { AlertCircle, Info, Settings } from "lucide-react";
import { Example } from "@floot/examples";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";
import { Button } from "./Button";

export default function TooltipShowcase() {
  return (
    <>
      <h1>Tooltip</h1>
      <p>
        A short label that appears next to a control to explain what it does. It
        opens on hover or keyboard focus and is anchored to its trigger - the
        examples below are held open so the label is visible at rest.
      </p>

      <h2>Examples</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <Example title="Information" width={420}>
          <div style={{ minHeight: 40 }}>
            <Tooltip open>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm">
                  <Info size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                Helpful information tooltip
              </TooltipContent>
            </Tooltip>
          </div>
        </Example>

        <Example title="Settings" width={420}>
          <div style={{ minHeight: 40 }}>
            <Tooltip open>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm">
                  <Settings size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Configure settings</TooltipContent>
            </Tooltip>
          </div>
        </Example>

        <Example title="Warning" width={420}>
          <div style={{ minHeight: 40 }}>
            <Tooltip open>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm">
                  <AlertCircle size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                Warning: This action cannot be undone
              </TooltipContent>
            </Tooltip>
          </div>
        </Example>

        <Example
          title="Longer content"
          description="The content wraps at the tooltip's maximum width."
          width={420}
        >
          <div style={{ minHeight: 150 }}>
            <Tooltip open>
              <TooltipTrigger asChild>
                <Button variant="link">Hover for more details</Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">
                This is a longer tooltip that explains more detailed information
                about the feature or action being described.
              </TooltipContent>
            </Tooltip>
          </div>
        </Example>
      </div>
    </>
  );
}
