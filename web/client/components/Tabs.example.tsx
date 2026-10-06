import { Example } from "@floot/examples";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./Tabs";

export default function TabsShowcase() {
  return (
    <>
      <h1>Tabs</h1>
      <p>
        A set of layered sections where only one panel is visible at a time.
      </p>

      <h2>Examples</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <Example title="Basic" fullBleed>
          <Tabs defaultValue="tab1">
            <TabsList>
              <TabsTrigger value="tab1">Account</TabsTrigger>
              <TabsTrigger value="tab2">Settings</TabsTrigger>
              <TabsTrigger value="tab3">Profile</TabsTrigger>
            </TabsList>
            <TabsContent value="tab1">
              Account settings and preferences
            </TabsContent>
            <TabsContent value="tab2">System configuration options</TabsContent>
            <TabsContent value="tab3">User profile information</TabsContent>
          </Tabs>
        </Example>

        <Example title="Many tabs" fullBleed>
          <Tabs defaultValue="code">
            <TabsList>
              <TabsTrigger value="code">Code</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
              <TabsTrigger value="tests">Tests</TabsTrigger>
              <TabsTrigger value="deployment">Deployment</TabsTrigger>
            </TabsList>
            <TabsContent value="code">Source code editor</TabsContent>
            <TabsContent value="preview">
              Live preview of the application
            </TabsContent>
            <TabsContent value="tests">Test suite results</TabsContent>
            <TabsContent value="deployment">
              Deployment configuration
            </TabsContent>
          </Tabs>
        </Example>

        <Example title="Disabled tab" fullBleed>
          <Tabs defaultValue="active">
            <TabsList>
              <TabsTrigger value="active">Active</TabsTrigger>
              <TabsTrigger value="pending">Pending</TabsTrigger>
              <TabsTrigger value="completed" disabled>
                Completed
              </TabsTrigger>
            </TabsList>
            <TabsContent value="active">Active items list</TabsContent>
            <TabsContent value="pending">Pending items list</TabsContent>
            <TabsContent value="completed">Completed items list</TabsContent>
          </Tabs>
        </Example>
      </div>
    </>
  );
}
