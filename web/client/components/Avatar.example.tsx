import { Example } from "@floot/examples";
import { Avatar, AvatarImage, AvatarFallback } from "./Avatar";

export default function AvatarShowcase() {
  return (
    <>
      <h1>Avatar</h1>
      <p>
        A small circular image representing a user, with initials shown when the
        image is unavailable.
      </p>

      <h2>States</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example title="With image">
          <Avatar>
            <AvatarImage src="https://github.com/yyjhao.png" alt="User avatar" />
            <AvatarFallback>CN</AvatarFallback>
          </Avatar>
        </Example>

        <Example title="Fallback only">
          <Avatar>
            <AvatarFallback>JD</AvatarFallback>
          </Avatar>
        </Example>

        <Example title="Broken image" description="Falls back to initials.">
          <Avatar>
            <AvatarImage src="https://invalid.url/image.jpg" alt="Broken image" />
            <AvatarFallback>EM</AvatarFallback>
          </Avatar>
        </Example>
      </div>
    </>
  );
}
