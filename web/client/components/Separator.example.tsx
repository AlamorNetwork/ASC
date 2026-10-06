import { Example } from "@floot/examples";
import { Separator } from "./Separator";

export default function SeparatorShowcase() {
  return (
    <>
      <h1>Separator</h1>
      <p>A thin rule that divides content, either horizontally or vertically.</p>

      <h2>Orientation</h2>
      <Example title="Horizontal" fullBleed>
        <div>
          <div>Above content</div>
          <Separator />
          <div>Below content</div>
        </div>
      </Example>

      <Example title="Vertical" fullBleed>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: "1.5rem",
            gap: "var(--spacing-sm)",
          }}
        >
          <span>Left</span>
          <Separator orientation="vertical" />
          <span>Right</span>
        </div>
      </Example>

      <Example title="Multiple vertical" fullBleed>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: "1.5rem",
            gap: "var(--spacing-sm)",
          }}
        >
          <span>Item 1</span>
          <Separator orientation="vertical" />
          <span>Item 2</span>
          <Separator orientation="vertical" />
          <span>Item 3</span>
        </div>
      </Example>

      <h2>Semantics</h2>
      <Example
        title="Non-decorative"
        description="Exposed to assistive technology as a separator instead of being hidden."
        fullBleed
      >
        <div>
          <div>Section 1</div>
          <Separator decorative={false} />
          <div>Section 2</div>
        </div>
      </Example>
    </>
  );
}
