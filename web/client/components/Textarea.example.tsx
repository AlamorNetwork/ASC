import { Example } from "@floot/examples";
import { Textarea } from "./Textarea";

const row = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  alignItems: "flex-start",
} as const;

export default function TextareaShowcase() {
  return (
    <>
      <h1>Textarea</h1>
      <p>A multi-line text field for longer free-form input.</p>

      <h2>Variants</h2>
      <div style={row}>
        <Example title="Default">
          <Textarea placeholder="Enter your description..." />
        </Example>
        <Example title="Clear">
          <Textarea placeholder="Clear textarea" rows={4} variant="clear" />
        </Example>
      </div>

      <h2>Options</h2>
      <div style={row}>
        <Example title="Non-resizable">
          <Textarea placeholder="This textarea cannot be resized" disableResize />
        </Example>
        <Example title="Multiline">
          <Textarea placeholder="Multiline textarea" rows={10} />
        </Example>
      </div>

      <h2>States</h2>
      <div style={row}>
        <Example title="Disabled">
          <Textarea placeholder="Disabled textarea" disabled />
        </Example>
      </div>
    </>
  );
}
