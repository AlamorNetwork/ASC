import { Bell } from "lucide-react";
import { Example } from "@floot/examples";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";
import { Button } from "./Button";

export default function PopoverShowcase() {
  return (
    <>
      <h1>Popover</h1>
      <p>
        A floating panel anchored to a trigger, holding rich content such as
        text, controls, or a card. <code>removeBackgroundAndPadding</code> drops
        the default panel chrome so the content can supply its own.
      </p>

      <h2>Examples</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <Example
          title="Basic"
          description="The default panel, with its own surface and padding."
          width={420}
        >
          <div style={{ minHeight: 130 }}>
            <Popover open modal={false}>
              <PopoverTrigger asChild>
                <Button>Click me</Button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="start">
                <p style={{ margin: 0 }}>
                  This is a basic popover with simple text content.
                </p>
              </PopoverContent>
            </Popover>
          </div>
        </Example>

        <Example
          title="Custom card"
          description="Panel chrome removed, so the content draws its own surface."
          width={420}
        >
          <div style={{ minHeight: 110 }}>
            <Popover open modal={false}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon">
                  <Bell size={16} />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="start"
                removeBackgroundAndPadding
              >
                <div
                  style={{
                    background: "var(--surface)",
                    padding: "var(--spacing-3)",
                    border: "1px solid var(--border)",
                  }}
                >
                  Card
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </Example>
      </div>
    </>
  );
}
