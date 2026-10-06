import { Example } from "@floot/examples";
import { Switch } from "./Switch";

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

export default function SwitchShowcase() {
  return (
    <>
      <h1>Switch</h1>
      <p>A toggle that turns a single setting on or off.</p>

      <h2>States</h2>
      <div style={row}>
        <Example title="Off">
          <div style={field}>
            <Switch id="airplane-mode" />
            <label htmlFor="airplane-mode">Airplane Mode</label>
          </div>
        </Example>
        <Example title="Disabled unchecked">
          <div style={field}>
            <Switch id="disabled-unchecked" disabled />
            <label htmlFor="disabled-unchecked">Disabled Unchecked</label>
          </div>
        </Example>
        <Example title="Disabled checked">
          <div style={field}>
            <Switch id="disabled-checked" disabled defaultChecked />
            <label htmlFor="disabled-checked">Disabled Checked</label>
          </div>
        </Example>
      </div>
    </>
  );
}
