// Motion's two screens: the library (#/motion) and one video's editor (#/motion/<id>).

import { useEffect, useState } from "react";

import { motionApi } from "./api";
import Editor from "./Editor";
import Library from "./Library";
import type { MotionHealth } from "./types";
import "./motion.css";

export default function MotionApp({ projectId, navigate }: { projectId: string | null; navigate: (hash: string) => void }) {
  const [health, setHealth] = useState<MotionHealth | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    motionApi
      .health()
      .then(setHealth)
      .catch(() => setDown(true));
  }, []);

  if (down) {
    return (
      <div className="page">
        <div className="banner banner-error" role="alert">
          The app's server is not running. Start it with <code>backend\run.ps1</code>, then reload this page.
        </div>
      </div>
    );
  }
  if (projectId) {
    return <Editor key={projectId} projectId={projectId} health={health} onBack={() => navigate("#/motion")} onOpen={(id) => navigate(`#/motion/${id}`)} />;
  }
  return <Library health={health} onOpen={(id) => navigate(`#/motion/${id}`)} />;
}
