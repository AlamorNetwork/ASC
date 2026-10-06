import { CalendarDays, MessageCircle } from "lucide-react";
import { Example } from "@floot/examples";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./HoverCard";
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar";

export default function HoverCardShowcase() {
  return (
    <>
      <h1>HoverCard</h1>
      <p>
        A card anchored to a link or control that previews more detail about it
        on hover.
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
        <Example title="User profile" width={420}>
          <div style={{ minHeight: 135 }}>
            <HoverCard open>
              <HoverCardTrigger asChild>
                <a
                  href="#"
                  style={{
                    textDecoration: "none",
                    color: "var(--color-primary)",
                  }}
                >
                  @sarah_designer
                </a>
              </HoverCardTrigger>
              <HoverCardContent side="bottom" align="start">
                <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                  <Avatar>
                    <AvatarImage src="https://picsum.photos/id/64/100" />
                    <AvatarFallback>SD</AvatarFallback>
                  </Avatar>
                  <div>
                    <div
                      style={{
                        fontSize: "var(--font-size-md)",
                        fontWeight: "var(--font-weight-bold)",
                        marginBottom: "var(--spacing-xxs)",
                      }}
                    >
                      Sarah Designer
                    </div>
                    <div
                      style={{
                        fontSize: "var(--font-size-sm)",
                        color: "var(--color-text-secondary)",
                        marginBottom: "var(--spacing-xs)",
                      }}
                    >
                      UI/UX Designer &amp; Creative Director
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: "var(--spacing-sm)",
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--spacing-xxs)",
                        }}
                      >
                        <CalendarDays size={14} />
                        <span style={{ fontSize: "var(--font-size-xs)" }}>
                          Joined Dec 2023
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--spacing-xxs)",
                        }}
                      >
                        <MessageCircle size={14} />
                        <span style={{ fontSize: "var(--font-size-xs)" }}>
                          1.2K posts
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>
        </Example>
      </div>
    </>
  );
}
