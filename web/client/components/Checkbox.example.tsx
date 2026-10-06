import { useState } from "react";
import { Example } from "@floot/examples";
import { Checkbox } from "./Checkbox";

const row = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  alignItems: "flex-start",
} as const;

const field = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
} as const;

function ControlledCheckboxExample() {
  const [isChecked, setIsChecked] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={field}>
        <Checkbox
          id="controlled"
          checked={isChecked}
          onChange={(e) => setIsChecked(e.target.checked)}
        />
        <label htmlFor="controlled">Controlled checkbox</label>
      </div>
      <div style={{ fontSize: "14px", color: "var(--muted-foreground)" }}>
        Checked: {isChecked ? "true" : "false"}
      </div>
    </div>
  );
}

export default function CheckboxShowcase() {
  return (
    <>
      <h1>Checkbox</h1>
      <p>A square control for toggling a single option on or off.</p>

      <h2>States</h2>
      <div style={row}>
        <Example title="Unchecked">
          <div style={field}>
            <Checkbox id="basic" />
            <label htmlFor="basic">Basic checkbox</label>
          </div>
        </Example>
        <Example title="Checked">
          <div style={field}>
            <Checkbox id="checked" defaultChecked />
            <label htmlFor="checked">Checked by default</label>
          </div>
        </Example>
        <Example title="Disabled">
          <div style={field}>
            <Checkbox id="disabled" disabled />
            <label htmlFor="disabled">Disabled</label>
          </div>
        </Example>
        <Example title="Disabled checked">
          <div style={field}>
            <Checkbox id="disabledChecked" disabled defaultChecked />
            <label htmlFor="disabledChecked">Disabled checked</label>
          </div>
        </Example>
      </div>

      <h2>Controlled</h2>
      <div style={row}>
        <Example title="Controlled">
          <ControlledCheckboxExample />
        </Example>
      </div>
    </>
  );
}
