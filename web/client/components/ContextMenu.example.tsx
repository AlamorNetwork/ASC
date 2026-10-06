import { Example } from "@floot/examples";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ContextMenu";

export default function ContextMenuShowcase() {
  return (
    <>
      <h1>ContextMenu</h1>
      <p>
        A menu that opens where the pointer is when an area is right-clicked,
        with items, shortcuts, checkbox items, and nested submenus.
      </p>

      <h2>Examples</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example title="File actions">
          <ContextMenu modal={false}>
            <ContextMenuTrigger>
              <div
                style={{
                  padding: "var(--spacing-xl)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--color-text-primary)",
                }}
              >
                Right click here
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuLabel>File Operations</ContextMenuLabel>
              <ContextMenuItem>
                New File
                <ContextMenuShortcut>?N</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem>
                Open
                <ContextMenuShortcut>?O</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuLabel>View Options</ContextMenuLabel>
              <ContextMenuCheckboxItem checked>
                Show Hidden Files
              </ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem>Show Path Bar</ContextMenuCheckboxItem>
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger>Share</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem>Copy Link</ContextMenuItem>
                  <ContextMenuItem>Email</ContextMenuItem>
                  <ContextMenuItem>Message</ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
            </ContextMenuContent>
          </ContextMenu>
        </Example>
      </div>
    </>
  );
}
