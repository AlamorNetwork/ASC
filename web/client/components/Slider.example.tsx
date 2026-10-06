import { Example } from "@floot/examples";
import { Slider } from "./Slider";

const row = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  alignItems: "flex-start",
} as const;

export default function SliderShowcase() {
  return (
    <>
      <h1>Slider</h1>
      <p>A draggable track for picking a number, or a range of numbers, between a minimum and a maximum.</p>

      <h2>Values</h2>
      <div style={row}>
        <Example title="Single value">
          <Slider defaultValue={[50]} max={100} step={1} />
        </Example>
        <Example title="Stepped">
          <Slider defaultValue={[40]} max={100} step={10} />
        </Example>
        <Example title="Range">
          <Slider defaultValue={[20, 80]} max={100} step={1} />
        </Example>
      </div>

      <h2>States</h2>
      <div style={row}>
        <Example title="Disabled">
          <Slider defaultValue={[60]} max={100} step={1} disabled />
        </Example>
      </div>
    </>
  );
}
