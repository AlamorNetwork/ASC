import { Example, Stage } from "@floot/examples";
import { Button } from "./Button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "./Sheet";

export default function SheetShowcase() {
  return (
    <>
      <h1>Sheet</h1>
      <p>
        A panel anchored to one edge of the screen, for secondary content and
        settings. <code>side</code> picks the edge: <code>right</code> (the
        default), <code>left</code>, <code>top</code> or <code>bottom</code>.
      </p>

      <h2>Sides</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <Example title="Right" description="The default side">
          <Stage height={440}>
            {(container) => (
              <Sheet open modal={false}>
                <SheetContent container={container}>
                  <SheetHeader>
                    <SheetTitle>Sheet Title</SheetTitle>
                    <SheetDescription>
                      This is a basic sheet that slides in from the right side.
                    </SheetDescription>
                  </SheetHeader>
                  <div style={{ padding: "1rem" }}>
                    <p>Sheet content goes here</p>
                  </div>
                </SheetContent>
              </Sheet>
            )}
          </Stage>
        </Example>

        <Example
          title="Left with footer"
          description="A SheetFooter pinned below the content"
        >
          <Stage height={440}>
            {(container) => (
              <Sheet open modal={false}>
                <SheetContent side="left" container={container}>
                  <SheetHeader>
                    <SheetTitle>Settings</SheetTitle>
                    <SheetDescription>
                      Manage your account settings and preferences.
                    </SheetDescription>
                  </SheetHeader>
                  <div style={{ padding: "1rem" }}>
                    <p>Content area</p>
                  </div>
                  <SheetFooter>
                    <Button variant="outline">Cancel</Button>
                    <Button>Save Changes</Button>
                  </SheetFooter>
                </SheetContent>
              </Sheet>
            )}
          </Stage>
        </Example>

        <Example title="Bottom">
          <Stage height={440}>
            {(container) => (
              <Sheet open modal={false}>
                <SheetContent side="bottom" container={container}>
                  <SheetHeader>
                    <SheetTitle>Bottom Sheet</SheetTitle>
                    <SheetDescription>
                      This sheet slides up from the bottom of the screen.
                    </SheetDescription>
                  </SheetHeader>
                  <div style={{ padding: "1rem" }}>
                    <p>Bottom sheet content</p>
                  </div>
                </SheetContent>
              </Sheet>
            )}
          </Stage>
        </Example>
      </div>
    </>
  );
}
