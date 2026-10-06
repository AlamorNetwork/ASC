import { Example } from "@floot/examples";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./Resizable";

export default function ResizableShowcase() {
  return (
    <>
      <h1>Resizable</h1>
      <p>
        Panels split by a draggable handle. A <code>ResizablePanelGroup</code>{" "}
        runs horizontally or vertically, and groups can be nested inside a panel
        to build a layout.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
        <Example
          fullBleed
          title="Horizontal"
          description="Two panels side by side, divided by a vertical handle."
        >
          <ResizablePanelGroup direction="horizontal" style={{ height: "200px" }}>
            <ResizablePanel>Left Panel Content</ResizablePanel>
            <ResizableHandle />
            <ResizablePanel>Right Panel Content</ResizablePanel>
          </ResizablePanelGroup>
        </Example>

        <Example
          fullBleed
          title="Vertical"
          description="Two stacked panels, divided by a horizontal handle."
        >
          <ResizablePanelGroup direction="vertical" style={{ height: "200px" }}>
            <ResizablePanel>Top Panel Content</ResizablePanel>
            <ResizableHandle />
            <ResizablePanel>Bottom Panel Content</ResizablePanel>
          </ResizablePanelGroup>
        </Example>

        <Example
          fullBleed
          title="Nested"
          description="A vertical group inside the middle panel of a horizontal one."
        >
          <ResizablePanelGroup direction="horizontal" style={{ height: "200px" }}>
            <ResizablePanel>Navigation Panel</ResizablePanel>
            <ResizableHandle />
            <ResizablePanel>
              <ResizablePanelGroup direction="vertical">
                <ResizablePanel>Main Content</ResizablePanel>
                <ResizableHandle />
                <ResizablePanel>Details Panel</ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel>Preview Panel</ResizablePanel>
          </ResizablePanelGroup>
        </Example>
      </div>
    </>
  );
}
