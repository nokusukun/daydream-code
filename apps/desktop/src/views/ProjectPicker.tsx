/**
 * First run: pick a project folder. The only screen without the workspace.
 *
 * It renders the same `ProjectRow` as the toolbar switcher, so the list you
 * learn on launch is the list you use forever after. Before, this screen and
 * the (nonexistent) switcher were going to be two designs for one job.
 */
import type { ReactNode } from "react";
import { rankProjects } from "../projects.js";
import { ProjectRow, useProjectList } from "./ProjectSwitcher.js";
import { WindowControls } from "../WindowControls.js";

const appIconUrl = new URL("../../icons/icon.svg", import.meta.url).href;

export function ProjectPicker(props: {
  opening: string | null;
  error: string | null;
  hasBridge: boolean;
  onOpen(rootPath: string): void;
  onPick(): void;
}): ReactNode {
  const { home, projects, loaded } = useProjectList();

  return (
    <div className="picker">
      <div className="picker-drag">
        <WindowControls />
      </div>
      <div className="picker-inner">
        <img className="picker-mark" src={appIconUrl} alt="" aria-hidden="true" />
        <h1>Daydream Code</h1>

        {props.hasBridge ? (
          <button type="button" className="btn btn-primary" onClick={props.onPick}>
            Open project folder…
          </button>
        ) : (
          <p className="picker-sub">
            Running outside the desktop app. Point the renderer at a core with{" "}
            <code>#url=http://host:port&amp;token=…</code>
          </p>
        )}

        {props.error !== null && <div className="error-bar">{props.error}</div>}

        {loaded && projects.length > 0 && (
          <div className="picker-recent">
            <div className="picker-recent-head">recent</div>
            {rankProjects(projects, "").map((project) => (
              <ProjectRow
                key={project.rootPath}
                project={project}
                home={home}
                opening={props.opening === project.rootPath}
                onOpen={props.onOpen}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
