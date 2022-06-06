/* eslint-disable no-useless-escape */
/* eslint-disable @typescript-eslint/no-explicit-any */
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import { CommandFactory } from './commands';
import { debounce } from 'lodash';
import { ExecuteCommandParams, ExecuteCommandRequest, integer, SymbolKind } from 'vscode-languageserver-protocol';
import { GoExtensionContext } from './context';


class SymbolItem implements vscode.QuickPickItem {
	public label: string;
	public description: string;
	public name: string;
	public package: string;
	public location: vscode.Location;
	constructor(symbol: vscode.SymbolInformation) {
		const kindName = vscode.SymbolKind[symbol.kind].toLowerCase();
		this.label = `$(symbol-${kindName}) ${symbol.name}`;
		this.description = symbol.containerName;
		this.name = symbol.name.split('.').pop(); // in case, symbol contains package name.
		this.package = symbol.containerName;
		this.location = symbol.location;
	}
}



export const implCursor: CommandFactory = (ctx, goCtx) => async () => {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage('No active editor found to implement interfaces.');
		return;
	}

	const cursorPosition = editor.selection.start;
	const wordRange = editor.document.getWordRangeAtPosition(cursorPosition);
	const selectedText = wordRange ? editor.document.getText(wordRange) : '';

	// TODO: Type with underlying types have different vscode.SymbolKinds than structs. 
	// Unfortunately, they also share those vscode.SymbolKinds with non-type symbols.
	// E.g. both type Foo func() and func foo() {} are a vscode.SymbolKind.Function.
	// We cannot just implement this as a snippet and levergage stubbing in gopls currently 
	// as gopls needs the concrete type to stub. 

	// TODO: It only makes sense to being able to find symbols that are within the same package
	const structItem = await quickPickSymbol("Input struct name (e.g. Client)", selectedText, [vscode.SymbolKind.Struct, vscode.SymbolKind.Class]);
	const interfaceItem = await quickPickSymbol("Input inteface name (e.g. Client)", '', [vscode.SymbolKind.Interface]);

	generateInterfaceStubs(goCtx, editor, structItem, interfaceItem);
}

async function quickPickSymbol(placeholder: string, initialValue: string, allowedKinds: vscode.SymbolKind[]): Promise<SymbolItem> {
	return new Promise((resolve, reject) => {
		const quickPick = vscode.window.createQuickPick()
		quickPick.placeholder = placeholder
		quickPick.canSelectMany = false;
		quickPick.value = initialValue;
	
		const search = async function (keyword: string) {
			quickPick.busy = true;
			const symbols = await vscode.commands
				.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', keyword);
			
			const items = symbols
				.filter(s => allowedKinds.includes(s.kind))
				.map(s => new SymbolItem(s))

			quickPick.items = items;
			quickPick.busy = false;
		};

		// Note: Immediately populate the results to provide a snappier experience.
		search(quickPick.value);
	
		quickPick.onDidChangeValue(debounce(search, 250));
		quickPick.onDidChangeSelection((selections: readonly vscode.QuickPickItem[]) => {
			if (typeof selections === 'undefined') {
				return;
			}
			
			const item = selections[0];
			if (item instanceof SymbolItem) {
				resolve(item);
				quickPick.dispose();
			}
		});
		quickPick.show();
	})
}


async function generateInterfaceStubs(goCtx: GoExtensionContext, editor: vscode.TextEditor, structItem: SymbolItem, interfaceItem: SymbolItem): Promise<void> {
	const { languageClient, serverInfo } = goCtx;
	const COMMAND = 'gopls.generate_interface_stubs';

	if (languageClient && serverInfo?.Commands?.includes(COMMAND)) {
		try {
			const uri = languageClient.code2ProtocolConverter.asTextDocumentIdentifier(editor.document).uri;
			const concreteLocation = languageClient.code2ProtocolConverter.asLocation(structItem.location);
			const interfaceLocation = languageClient.code2ProtocolConverter.asLocation(interfaceItem.location);
			const params: ExecuteCommandParams = {
				command: COMMAND,
				arguments: [
					{
						URI: uri,
						ConcreteLocation: concreteLocation,
						InterfaceLocation: interfaceLocation
					}
				]
			};

			console.log(JSON.stringify(params.arguments));
			const resp = await languageClient.sendRequest(ExecuteCommandRequest.type, params);
			return resp.Packages;
		} catch (e) {
			vscode.window.showErrorMessage('Failed to generate interface method stubs.');
			console.log(`error with ${COMMAND}: ${e}`);
		}
	}
}