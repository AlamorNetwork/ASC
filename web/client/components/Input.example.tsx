import { Example } from "@floot/examples";
import { Search } from "lucide-react";
import { Input } from "./Input";

const row = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  alignItems: "flex-start",
} as const;

function SearchInputExample() {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <Search
        size={18}
        style={{
          position: "absolute",
          left: "var(--spacing-3)",
          color: "var(--muted-foreground)",
          pointerEvents: "none",
        }}
      />
      <Input
        type="search"
        placeholder="Search..."
        style={{ paddingLeft: "calc(var(--spacing-3) * 2 + 18px)" }}
      />
    </div>
  );
}

export default function InputShowcase() {
  return (
    <>
      <h1>Input</h1>
      <p>A single-line text field for collecting short values.</p>

      <h2>States</h2>
      <div style={row}>
        <Example title="Placeholder">
          <Input placeholder="Placeholder text" />
        </Example>
        <Example title="Hover" forceState="hover">
          <Input placeholder="Hover over me" />
        </Example>
        <Example title="Filled">
          <Input defaultValue="Filled value" />
        </Example>
        <Example title="Disabled">
          <Input defaultValue="Disabled" disabled />
        </Example>
        <Example title="Read-only">
          <Input defaultValue="Read-only" readOnly />
        </Example>
      </div>

      <h2>Types</h2>
      <div style={row}>
        <Example title="Text">
          <Input type="text" placeholder="Text" />
        </Example>
        <Example title="Password">
          <Input type="password" placeholder="Password" />
        </Example>
        <Example title="Email">
          <Input type="email" placeholder="Email" />
        </Example>
        <Example title="Number">
          <Input type="number" placeholder="Number" />
        </Example>
        <Example title="Search">
          <Input type="search" placeholder="Search" />
        </Example>
      </div>

      <h2>With an icon</h2>
      <div style={row}>
        <Example title="Search with icon">
          <SearchInputExample />
        </Example>
      </div>
    </>
  );
}
