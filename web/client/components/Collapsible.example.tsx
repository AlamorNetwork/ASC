import { Example } from "@floot/examples";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./Collapsible";
import { Button } from "./Button";

export default function CollapsibleShowcase() {
  return (
    <>
      <h1>Collapsible</h1>
      <p>
        A single section of content that expands and collapses from its own
        trigger.
      </p>

      <h2>Usage</h2>
      <Example title="Basic" width={480}>
        <Collapsible>
          <CollapsibleTrigger>Click to expand</CollapsibleTrigger>
          <CollapsibleContent>
            This is the collapsible content that will be shown when triggered.
          </CollapsibleContent>
        </Collapsible>
      </Example>

      <Example
        title="Separate trigger"
        description="The trigger renders as a button beside a non-clickable title."
        width={480}
      >
        <Collapsible>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ flex: 1 }}>Non clickable title</div>
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="ghost">
                Toggle
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            This is the collapsible content that will be shown when triggered.
          </CollapsibleContent>
        </Collapsible>
      </Example>
    </>
  );
}
