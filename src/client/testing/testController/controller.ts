/* eslint-disable class-methods-use-this */
/* eslint-disable @typescript-eslint/no-unused-vars */
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { TestController, TestItem, WorkspaceFolder, CancellationTokenSource, Uri, EventEmitter } from 'vscode';
import { IExtensionSingleActivationService } from '../../activation/types';
import { ICommandManager, IWorkspaceService } from '../../common/application/types';
import * as constants from '../../common/constants';
import { IConfigurationService, IDisposableRegistry, Resource } from '../../common/types';
import { DelayedTrigger, IDelayedTrigger } from '../../common/utils/delayTrigger';
import { noop } from '../../common/utils/misc';
import { IInterpreterService } from '../../interpreter/contracts';
import { traceVerbose } from '../../logging';
import { sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { PYTEST_PROVIDER, UNITTEST_PROVIDER } from '../common/constants';
import { getNodeByUri } from './common/testItemUtilities';
import {
    ITestController,
    ITestFrameworkController,
    TestRefreshOptions,
} from './common/types';

// Types gymnastics to make sure that sendTriggerTelemetry only accepts the correct types.
// type EventPropertyType = IEventNamePropertyMapping[EventName.UNITTEST_DISCOVERY_TRIGGER];
// type TriggerKeyType = keyof EventPropertyType;
// type TriggerType = EventPropertyType[TriggerKeyType];

@injectable()
export class PythonTestController implements ITestController, IExtensionSingleActivationService {
    public readonly supportedWorkspaceTypes = { untrustedWorkspace: false, virtualWorkspace: false };

    // private readonly testAdapters: Map<Uri, WorkspaceTestAdapter> = new Map();

    // private readonly triggerTypes: TriggerType[] = [];

    private readonly testController: TestController;

    private readonly refreshData: IDelayedTrigger;

    private refreshCancellation: CancellationTokenSource;

    private readonly refreshingCompletedEvent: EventEmitter<void> = new EventEmitter<void>();

    private readonly refreshingStartedEvent: EventEmitter<void> = new EventEmitter<void>();

    private readonly runWithoutConfigurationEvent: EventEmitter<WorkspaceFolder[]> = new EventEmitter<
        WorkspaceFolder[]
    >();

    public readonly onRefreshingCompleted = this.refreshingCompletedEvent.event;

    public readonly onRefreshingStarted = this.refreshingStartedEvent.event;

    public readonly onRunWithoutConfiguration = this.runWithoutConfigurationEvent.event;

    private sendTestDisabledTelemetry = true;

    constructor(
        @inject(IWorkspaceService) private readonly workspaceService: IWorkspaceService,
        @inject(IConfigurationService) private readonly configSettings: IConfigurationService,
        @inject(ITestFrameworkController) @named(PYTEST_PROVIDER) private readonly pytest: ITestFrameworkController,
        @inject(ITestFrameworkController) @named(UNITTEST_PROVIDER) private readonly unittest: ITestFrameworkController,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService,
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
    ) {
        this.refreshCancellation = new CancellationTokenSource();

        this.testController = {
            items: {
                add() {
                    throw new Error('testController items add');
                },
                replace() {
                    throw new Error('testController items replace');
                },
                get() {
                    return undefined;
                },
                delete() {
                    /* noop */
                },
                size: 0,
                forEach() {
                    /* noop */
                },
                [Symbol.iterator]() {
                    return [][Symbol.iterator]();
                },
            },
            id: '',
            label: '',
            dispose() {
                /* noop */
            },
            createRunProfile() {
                throw new Error('TestController.createRunProfile');
            },
            createTestItem() {
                throw new Error('TestController.createTestItem');
            },
            createTestRun() {
                throw new Error('TestController.createTestRun');
            },
            refreshHandler() {
                throw new Error('TestController.refreshHandler');
            },
        } as TestController; // tests.createTestController('python-tests', 'Python Tests');

        this.disposables.push(this.testController);

        const delayTrigger = new DelayedTrigger(
            (uri: Uri, invalidate: boolean) => {
                this.refreshTestDataInternal(uri);
                if (invalidate) {
                    this.invalidateTests(uri);
                }
            },
            250, // Delay running the refresh by 250 ms
            'Refresh Test Data',
        );
        this.disposables.push(delayTrigger);
        this.refreshData = delayTrigger;
    }

    public activate(): Promise<void> {
        return Promise.resolve();
    }

    public refreshTestData(uri?: Resource, options?: TestRefreshOptions): Promise<void> {
        if (options?.forceRefresh) {
            if (uri === undefined) {
                // This is a special case where we want everything to be re-discovered.
                traceVerbose('Testing: Clearing all discovered tests');
                this.testController.items.forEach((item) => {
                    const ids: string[] = [];
                    item.children.forEach((child) => ids.push(child.id));
                    ids.forEach((id) => item.children.delete(id));
                });

                traceVerbose('Testing: Forcing test data refresh');
                return this.refreshTestDataInternal(undefined);
            }

            traceVerbose('Testing: Forcing test data refresh');
            return this.refreshTestDataInternal(uri);
        }

        this.refreshData.trigger(uri, false);
        return Promise.resolve();
    }

    public stopRefreshing(): void {
        this.refreshCancellation.cancel();
        this.refreshCancellation.dispose();
        this.refreshCancellation = new CancellationTokenSource();
    }

    public clearTestController(): void {
        const ids: string[] = [];
        this.testController.items.forEach((item) => ids.push(item.id));
        ids.forEach((id) => this.testController.items.delete(id));
    }

    private async refreshTestDataInternal(uri?: Resource): Promise<void> {
        this.refreshingStartedEvent.fire();
        if (uri) {
            const settings = this.configSettings.getSettings(uri);
            traceVerbose(`Testing: Refreshing test data for ${uri.fsPath}`);
            if (settings.testing.pytestEnabled) {
                // Ensure we send test telemetry if it gets disabled again
                this.sendTestDisabledTelemetry = true;
                // ** uncomment ~231 - 241 to NEW new test discovery mechanism
                // const workspace = this.workspaceService.getWorkspaceFolder(uri);
                // traceVerbose(`Discover tests for workspace name: ${workspace?.name} - uri: ${uri.fsPath}`);
                // const testAdapter =
                //     this.testAdapters.get(uri) || (this.testAdapters.values().next().value as WorkspaceTestAdapter);
                // testAdapter.discoverTests(
                //     this.testController,
                //     this.refreshCancellation.token,
                //     this.testAdapters.size > 1,
                //     this.workspaceService.workspaceFile?.fsPath,
                //     this.pythonExecFactory,
                // );
                // uncomment ~243 to use OLD test discovery mechanism
                await this.pytest.refreshTestData(this.testController, uri, this.refreshCancellation.token);
            } else if (settings.testing.unittestEnabled) {
                // ** Ensure we send test telemetry if it gets disabled again
                this.sendTestDisabledTelemetry = true;
                // uncomment ~248 - 258 to NEW new test discovery mechanism
                // const workspace = this.workspaceService.getWorkspaceFolder(uri);
                // traceVerbose(`Discover tests for workspace name: ${workspace?.name} - uri: ${uri.fsPath}`);
                // const testAdapter =
                //     this.testAdapters.get(uri) || (this.testAdapters.values().next().value as WorkspaceTestAdapter);
                // testAdapter.discoverTests(
                //     this.testController,
                //     this.refreshCancellation.token,
                //     this.testAdapters.size > 1,
                //     this.workspaceService.workspaceFile?.fsPath,
                // );
                // uncomment ~260 to use OLD test discovery mechanism
                await this.unittest.refreshTestData(this.testController, uri, this.refreshCancellation.token);
            } else {
                if (this.sendTestDisabledTelemetry) {
                    this.sendTestDisabledTelemetry = false;
                    sendTelemetryEvent(EventName.UNITTEST_DISABLED);
                }
                // If we are here we may have to remove an existing node from the tree
                // This handles the case where user removes test settings. Which should remove the
                // tests for that particular case from the tree view
                const workspace = this.workspaceService.getWorkspaceFolder(uri);
                if (workspace) {
                    const toDelete: string[] = [];
                    this.testController.items.forEach((i: TestItem) => {
                        const w = this.workspaceService.getWorkspaceFolder(i.uri);
                        if (w?.uri.fsPath === workspace.uri.fsPath) {
                            toDelete.push(i.id);
                        }
                    });
                    toDelete.forEach((i) => this.testController.items.delete(i));
                }
            }
        } else {
            traceVerbose('Testing: Refreshing all test data');
            const workspaces: readonly WorkspaceFolder[] = this.workspaceService.workspaceFolders || [];
            await Promise.all(
                workspaces.map(async (workspace) => {
                    if (!(await this.interpreterService.getActiveInterpreter(workspace.uri))) {
                        this.commandManager
                            .executeCommand(constants.Commands.TriggerEnvironmentSelection, workspace.uri)
                            .then(noop, noop);
                        return;
                    }
                    await this.refreshTestDataInternal(workspace.uri);
                }),
            );
        }
        this.refreshingCompletedEvent.fire();
        return Promise.resolve();
    }

    /*
    private async resolveChildren(item: TestItem | undefined): Promise<void> {
        if (item) {
            traceVerbose(`Testing: Resolving item ${item.id}`);
            const settings = this.configSettings.getSettings(item.uri);
            if (settings.testing.pytestEnabled) {
                return this.pytest.resolveChildren(this.testController, item, this.refreshCancellation.token);
            }
            if (settings.testing.unittestEnabled) {
                return this.unittest.resolveChildren(this.testController, item, this.refreshCancellation.token);
            }
        } else {
            traceVerbose('Testing: Refreshing all test data');
            this.sendTriggerTelemetry('auto');
            const workspaces: readonly WorkspaceFolder[] = this.workspaceService.workspaceFolders || [];
            await Promise.all(
                workspaces.map(async (workspace) => {
                    if (!(await this.interpreterService.getActiveInterpreter(workspace.uri))) {
                        traceError('Cannot trigger test discovery as a valid interpreter is not selected');
                        return;
                    }
                    await this.refreshTestDataInternal(workspace.uri);
                }),
            );
        }
        return Promise.resolve();
    }

    private async runTests(request: TestRunRequest, token: CancellationToken): Promise<void> {
        const workspaces: WorkspaceFolder[] = [];
        if (request.include) {
            uniq(request.include.map((r) => this.workspaceService.getWorkspaceFolder(r.uri))).forEach((w) => {
                if (w) {
                    workspaces.push(w);
                }
            });
        } else {
            (this.workspaceService.workspaceFolders || []).forEach((w) => workspaces.push(w));
        }
        const runInstance = this.testController.createTestRun(
            request,
            `Running Tests for Workspace(s): ${workspaces.map((w) => w.uri.fsPath).join(';')}`,
            true,
        );

        const dispose = token.onCancellationRequested(() => {
            runInstance.end();
        });

        const unconfiguredWorkspaces: WorkspaceFolder[] = [];
        try {
            await Promise.all(
                workspaces.map(async (workspace) => {
                    if (!(await this.interpreterService.getActiveInterpreter(workspace.uri))) {
                        this.commandManager
                            .executeCommand(constants.Commands.TriggerEnvironmentSelection, workspace.uri)
                            .then(noop, noop);
                        return undefined;
                    }
                    const testItems: TestItem[] = [];
                    // If the run request includes test items then collect only items that belong to
                    // `workspace`. If there are no items in the run request then just run the `workspace`
                    // root test node. Include will be `undefined` in the "run all" scenario.
                    (request.include ?? this.testController.items).forEach((i: TestItem) => {
                        const w = this.workspaceService.getWorkspaceFolder(i.uri);
                        if (w?.uri.fsPath === workspace.uri.fsPath) {
                            testItems.push(i);
                        }
                    });

                    const settings = this.configSettings.getSettings(workspace.uri);
                    if (testItems.length > 0) {
                        if (settings.testing.pytestEnabled) {
                            sendTelemetryEvent(EventName.UNITTEST_RUN, undefined, {
                                tool: 'pytest',
                                debugging: request.profile?.kind === TestRunProfileKind.Debug,
                            });
                            // ** new execution runner/adapter
                            // const testAdapter =
                            //     this.testAdapters.get(workspace.uri) ||
                            //     (this.testAdapters.values().next().value as WorkspaceTestAdapter);
                            // return testAdapter.executeTests(
                            //     this.testController,
                            //     runInstance,
                            //     testItems,
                            //     token,
                            //     request.profile?.kind === TestRunProfileKind.Debug,
                            //     this.pythonExecFactory,
                            // );

                            // below is old way of running pytest execution
                            return this.pytest.runTests(
                                {
                                    includes: testItems,
                                    excludes: request.exclude ?? [],
                                    runKind: request.profile?.kind ?? TestRunProfileKind.Run,
                                    runInstance,
                                },
                                workspace,
                                token,
                            );
                        }
                        if (settings.testing.unittestEnabled) {
                            // potentially squeeze in the new execution way here?
                            sendTelemetryEvent(EventName.UNITTEST_RUN, undefined, {
                                tool: 'unittest',
                                debugging: request.profile?.kind === TestRunProfileKind.Debug,
                            });
                            // new execution runner/adapter
                            // const testAdapter =
                            //     this.testAdapters.get(workspace.uri) ||
                            //     (this.testAdapters.values().next().value as WorkspaceTestAdapter);
                            // return testAdapter.executeTests(
                            //     this.testController,
                            //     runInstance,
                            //     testItems,
                            //     token,
                            //     request.profile?.kind === TestRunProfileKind.Debug,
                            // );

                            // below is old way of running unittest execution
                            return this.unittest.runTests(
                                {
                                    includes: testItems,
                                    excludes: request.exclude ?? [],
                                    runKind: request.profile?.kind ?? TestRunProfileKind.Run,
                                    runInstance,
                                },
                                workspace,
                                token,
                                this.testController,
                            );
                        }
                    }

                    if (!settings.testing.pytestEnabled && !settings.testing.unittestEnabled) {
                        unconfiguredWorkspaces.push(workspace);
                    }
                    return Promise.resolve();
                }),
            );
        } finally {
            runInstance.appendOutput(`Finished running tests!\r\n`);
            runInstance.end();
            dispose.dispose();
            if (unconfiguredWorkspaces.length > 0) {
                this.runWithoutConfigurationEvent.fire(unconfiguredWorkspaces);
            }
        }
    }
    */

    private invalidateTests(uri: Uri) {
        this.testController.items.forEach((root) => {
            const item = getNodeByUri(root, uri);
            if (item && !!item.invalidateResults) {
                // Minimize invalidating to test case nodes for the test file where
                // the change occurred
                item.invalidateResults();
            }
        });
    }
}
