import { Example } from "@floot/examples";
import { RadioGroup, RadioGroupItem } from "./RadioGroup";

export default function RadioGroupShowcase() {
  return (
    <>
      <h1>RadioGroup</h1>
      <p>A set of radio options where only one value can be selected at a time.</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "flex-start" }}>
        <Example title="Single selection">
          <RadioGroup name="size" defaultValue="medium">
            <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-md)" }}>
              <RadioGroupItem value="small" id="radio-small" />
              <label htmlFor="radio-small">Small</label>
              <RadioGroupItem value="medium" id="radio-medium" />
              <label htmlFor="radio-medium">Medium</label>
              <RadioGroupItem value="large" id="radio-large" />
              <label htmlFor="radio-large">Large</label>
            </div>
          </RadioGroup>
        </Example>
      </div>
    </>
  );
}
