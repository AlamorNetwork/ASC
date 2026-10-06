import { Example } from "@floot/examples";
import { ToggleGroup, ToggleGroupItem } from "./ToggleGroup";
import {
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
} from "lucide-react";

const row = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  alignItems: "flex-start",
} as const;

export default function ToggleGroupShowcase() {
  return (
    <>
      <h1>ToggleGroup</h1>
      <p>A row of toggle buttons that share a selection, sized and styled as one unit.</p>

      <h2>Variants</h2>
      <div style={row}>
        <Example title="Default with icons">
          <ToggleGroup type="single" size="md">
            <ToggleGroupItem value="bold" aria-label="Toggle bold">
              <Bold size={16} />
            </ToggleGroupItem>
            <ToggleGroupItem value="italic" aria-label="Toggle italic">
              <Italic size={16} />
            </ToggleGroupItem>
            <ToggleGroupItem value="underline" aria-label="Toggle underline">
              <Underline size={16} />
            </ToggleGroupItem>
          </ToggleGroup>
        </Example>
        <Example title="Outline with selection">
          <ToggleGroup type="single" defaultValue="left" size="lg" variant="outline">
            <ToggleGroupItem value="left" aria-label="Align left">
              <AlignLeft size={20} />
            </ToggleGroupItem>
            <ToggleGroupItem value="center" aria-label="Align center">
              <AlignCenter size={20} />
            </ToggleGroupItem>
            <ToggleGroupItem value="right" aria-label="Align right">
              <AlignRight size={20} />
            </ToggleGroupItem>
            <ToggleGroupItem value="justify" aria-label="Justify">
              <AlignJustify size={20} />
            </ToggleGroupItem>
          </ToggleGroup>
        </Example>
      </div>

      <h2>States</h2>
      <div style={row}>
        <Example title="Text with disabled item">
          <ToggleGroup type="single" defaultValue="1" size="sm">
            <ToggleGroupItem value="1">Option 1</ToggleGroupItem>
            <ToggleGroupItem value="2">Option 2</ToggleGroupItem>
            <ToggleGroupItem value="3" disabled>
              Disabled
            </ToggleGroupItem>
          </ToggleGroup>
        </Example>
      </div>
    </>
  );
}
