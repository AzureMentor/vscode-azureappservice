/*---------------------------------------------------------------------------------------------
*  Copyright (c) Microsoft Corporation. All rights reserved.
*  Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as fse from 'fs-extra';
import * as path from 'path';
import { MessageItem, TaskDefinition } from 'vscode';
import { DialogResponses } from 'vscode-azureextensionui';
import * as constants from '../../constants';
import { ext } from '../../extensionVariables';
import { isPathEqual } from '../../utils/pathUtils';
import { getWorkspaceSetting, updateWorkspaceSetting } from '../../vsCodeConfig/settings';
import * as tasks from '../../vsCodeConfig/tasks';
import { IDeployWizardContext } from "./IDeployWizardContext";

export async function setPreDeployTaskForDotnet(context: IDeployWizardContext): Promise<void> {
    const preDeployTaskSetting: string = 'preDeployTask';
    const showPreDeployWarningSetting: string = 'showPreDeployWarning';
    const workspaceFspath: string = context.workspace.uri.fsPath;

    // don't overwrite preDeploy or deploySubpath if it exists and respect configurePreDeployTasks setting
    if (!getWorkspaceSetting<boolean>(showPreDeployWarningSetting, workspaceFspath)
        || getWorkspaceSetting<string>(preDeployTaskSetting, workspaceFspath)
        || getWorkspaceSetting<string>(constants.configurationSettings.deploySubpath, workspaceFspath)) {
        return;
    }

    // if the user is deploying a different folder than the root, use this folder without setting up defaults
    if (!isPathEqual(context.deployFsPath, workspaceFspath)) {
        return;
    }

    const csprojFile: string | undefined = await tryGetCsprojFile(context, workspaceFspath);

    // if we found a .csproj file set the tasks and workspace settings
    if (csprojFile) {
        const targetFramework: string | undefined = await tryGetTargetFramework(csprojFile);
        context.telemetry.properties.tfw = targetFramework ? targetFramework : 'N/A';
        if (!targetFramework) {
            // if the target framework cannot be found, don't try to set defaults
            return;
        }

        const notConfiguredForDeploy: string = `Required assets to build and deploy are missing from "${context.workspace.name}"? Add them?`;
        const dontShowAgainButton: MessageItem = { title: "No, and don't show again" };
        const input: MessageItem = await ext.ui.showWarningMessage(notConfiguredForDeploy, { modal: true }, DialogResponses.yes, dontShowAgainButton);
        if (input === dontShowAgainButton) {
            await updateWorkspaceSetting(showPreDeployWarningSetting, false, workspaceFspath);
        } else {
            // resolves to "."if it is not a subfolder
            const subfolder: string = path.dirname(path.relative(workspaceFspath, csprojFile));

            // always use posix for debug config
            const deploySubpath: string = path.posix.join(subfolder, 'bin', 'Release', targetFramework, 'publish');

            await updateWorkspaceSetting(preDeployTaskSetting, 'publish', workspaceFspath);
            await updateWorkspaceSetting(constants.configurationSettings.deploySubpath, deploySubpath, workspaceFspath);

            // update the deployContext.deployFsPath with the .NET output path since getDeployFsPath is called prior to this
            context.deployFsPath = path.join(workspaceFspath, deploySubpath);

            const existingTasks: tasks.ITask[] = tasks.getTasks(context.workspace);

            // do not overwrite any dotnet commands the user may have
            let dotnetTasks: tasks.ITask[] = generateDotnetTasks(subfolder);
            dotnetTasks = dotnetTasks.filter(t1 => !existingTasks.find(t2 => {
                return t1.label === t2.label;
            }));

            const newTasks: tasks.ITask[] = existingTasks.concat(dotnetTasks);

            tasks.updateTasks(context.workspace, newTasks);
        }

    }
}

async function tryGetCsprojFile(context: IDeployWizardContext, projectPath: string): Promise<string | undefined> {
    let projectFiles: string[] = await checkFolderForCsproj(projectPath);
    // it's a common pattern to have the .csproj file in a subfolder so check one level deeper
    if (projectFiles.length === 0) {
        const subfolders: string[] = await fse.readdir(projectPath);
        await Promise.all(subfolders.map(async folder => {
            const filePath: string = path.join(projectPath, folder);
            // check its existence as this will check .vscode even if the project doesn't contain that folder
            if (fse.existsSync(filePath) && (await fse.stat(filePath)).isDirectory()) {
                projectFiles = projectFiles.concat(await checkFolderForCsproj(filePath));
            }
        }));
    }

    context.telemetry.properties.numOfCsprojFiles = projectFiles.length.toString();

    // if multiple csprojs were found, ignore them
    return projectFiles.length === 1 ? projectFiles[0] : undefined;

    async function checkFolderForCsproj(filePath: string): Promise<string[]> {
        const files: string[] = fse.readdirSync(filePath);
        const filePaths: string[] = files.map((f: string) => {
            return path.join(filePath, f);
        });

        return filePaths.filter((f: string) => /\.csproj$/i.test(f));
    }
}

async function tryGetTargetFramework(projFilePath: string): Promise<string | undefined> {
    const projContents: string = (await fse.readFile(projFilePath)).toString();
    const matches: RegExpMatchArray | null = projContents.match(/<TargetFramework>(.*)<\/TargetFramework>/);
    return matches === null ? undefined : matches[1];
}

function generateDotnetTasks(subfolder: string): TaskDefinition[] {
    // always use posix for debug config
    // tslint:disable-next-line: no-unsafe-any no-invalid-template-strings
    const cwd: string = path.posix.join('${workspaceFolder}', subfolder);

    const buildTask: TaskDefinition = {
        label: "build",
        command: "dotnet",
        type: "process",
        args: [
            "build",
            cwd,
            "/property:GenerateFullPaths=true",
            "/consoleloggerparameters:NoSummary"
        ],
        problemMatcher: "$msCompile"
    };

    const publishTask: TaskDefinition = {
        label: "publish",
        command: "dotnet",
        type: "process",
        args: [
            "publish",
            cwd,
            "/property:GenerateFullPaths=true",
            "/consoleloggerparameters:NoSummary"
        ],
        problemMatcher: "$msCompile"
    };

    const watchTask: TaskDefinition = {
        label: "watch",
        command: "dotnet",
        type: "process",
        args: [
            "watch",
            "run",
            cwd,
            "/property:GenerateFullPaths=true",
            "/consoleloggerparameters:NoSummary"
        ],
        problemMatcher: "$msCompile"
    };

    return [buildTask, publishTask, watchTask];
}
