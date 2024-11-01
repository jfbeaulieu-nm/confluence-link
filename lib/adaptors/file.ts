import { App, Component, MarkdownRenderer, Notice, TFile } from "obsidian";
import mermaid from 'mermaid';
import ADFBuilder from "lib/builder/adf";
import {
	AdfElement,
	ListItemElement,
	TaskItemElement,
} from "lib/builder/types";
import ConfluenceClient from "lib/confluence/client";
import PropertiesAdaptor from "./properties";
import ParagraphDirector from "lib/directors/paragraph";
import { ConfluenceLinkSettings } from "lib/confluence/types";
import TableDirector from "lib/directors/table";

export default class FileAdaptor {
	constructor(
		private readonly app: App,
		private readonly client: ConfluenceClient,
		private readonly spaceId: string,
		private readonly settings: ConfluenceLinkSettings
	) {
		// Initialize mermaid with specific configuration
		mermaid.initialize({
			startOnLoad: false,
			theme: 'default',
			securityLevel: 'loose',
			fontFamily: 'arial',
			htmlLabels: true,
			fontSize: 16
		});
	}

	async convertObs2Adf(text: string, path: string): Promise<AdfElement[]> {
		const container = document.createElement("div");

		MarkdownRenderer.render(
			this.app,
			text,
			container,
			path,
			new Component()
		);

		const adf = await this.htmlToAdf(container, path);
		return adf;
	}

	async htmlToAdf(
		container: HTMLElement,
		filePath: string
	): Promise<AdfElement[]> {
		const builder = new ADFBuilder();

		for (const node of Array.from(container.childNodes)) {
			await this.traverse(node as HTMLElement, builder, filePath);
		}

		return builder.build();
	}

	async getConfluenceLink(path: string): Promise<string> {
		const file = this.app.metadataCache.getFirstLinkpathDest(path, ".");

		if (!(file instanceof TFile)) {
			return "#";
		}
		const fileData = await this.app.vault.read(file);
		const propAdaptor = new PropertiesAdaptor().loadProperties(fileData);
		let { confluenceUrl } = propAdaptor.properties;

		if (confluenceUrl) {
			return confluenceUrl as string;
		}

		const response = await this.client.page.createPage({
			spaceId: this.spaceId,
			pageTitle: file.name,
		});
		confluenceUrl = response._links.base + response._links.webui;

		propAdaptor.addProperties({
			pageId: response.id,
			spaceId: response.spaceId,
			confluenceUrl,
		});
		await this.app.vault.modify(file, propAdaptor.toFile(fileData));

		const adf = await this.convertObs2Adf(fileData, path);

		await this.client.page.updatePage({
			pageId: propAdaptor.properties.pageId as string,
			pageTitle: file.name,
			adf,
		});

		new Notice(`Page Created: ${file.name}`);
		return confluenceUrl as string;
	}

	private async convertMermaidToImage(mermaidCode: string, pageId: string): Promise<string | null> {
		try {
			// Generate unique ID for the diagram
			const id = 'mermaid-' + Math.random().toString(36).substr(2, 9);

			// Render mermaid diagram to SVG string
			const { svg } = await mermaid.render(id, mermaidCode);

			// Create a temporary div to hold the SVG
			const div = document.createElement('div');
			div.innerHTML = svg;
			const svgElement = div.firstElementChild as SVGElement;

			// Set SVG attributes for proper sizing
			svgElement.setAttribute('width', '1200');
			svgElement.setAttribute('height', '800');
			svgElement.setAttribute('style', 'background-color: white;');

			// Convert SVG to string with XML declaration
			const svgString = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
				new XMLSerializer().serializeToString(svgElement);

			// Create blob and form data
			const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
			const formData = new FormData();
			const filename = `mermaid-${Date.now()}.svg`;
			formData.append('file', new File([svgBlob], filename, { type: 'image/svg+xml' }));

			// Upload SVG directly to Confluence
			const attachmentResponse = await this.client.attachement.uploadFile(pageId, formData);

			if (attachmentResponse?.results[0]?.extensions) {
				return attachmentResponse.results[0].extensions.fileId;
			}

			return null;
		} catch (error) {
			console.error('Error in convertMermaidToImage:', error);
			return null;
		}
	}

	async traverse(node: HTMLElement, builder: ADFBuilder, filePath: string) {
		switch (node.nodeName) {
			case "H1":
			case "H2":
			case "H3":
			case "H4":
			case "H5":
			case "H6":
				builder.addItem(
					builder.headingItem(
						Number(node.nodeName[1]),
						node.textContent!
					)
				);
				break;
			case "TABLE":
				const tableRows = Array.from(node.querySelectorAll("tr"));
				const tableContent = await Promise.all(
					tableRows.map(async (row) => {
						const cells = await Promise.all(
							Array.from(row.querySelectorAll("td, th")).map(
								async (cell) => {
									const cellAdf = new ADFBuilder();
									const director = new TableDirector(
										cellAdf,
										this,
										this.app,
										this.client,
										this.settings
									);

									await director.addItems(
										cell as HTMLTableCellElement,
										filePath
									);

									return cellAdf.build();
								}
							)
						);
						return builder.tableRowItem(cells);
					})
				);
				builder.addItem(builder.tableItem(tableContent));
				break;
			case "PRE":
				const codeElement = node.querySelector("code");
				if (codeElement) {
					const codeText = codeElement.textContent || "";
					const language = Array.from(codeElement.classList)
						.find(cls => cls.startsWith('language-'))
						?.replace('language-', '');

					if (language === 'mermaid') {
						try {
							const file = this.app.vault.getAbstractFileByPath(filePath);
							
							if (file instanceof TFile) {
								const fileData = await this.app.vault.read(file);
								const propAdaptor = new PropertiesAdaptor().loadProperties(fileData);
								const pageId = propAdaptor.properties.pageId as string;
								
								if (pageId) {
									const fileId = await this.convertMermaidToImage(codeText, pageId);
									if (fileId) {
										// Add the image to the Confluence page with original size
										builder.addItem(builder.mediaSingleItem(fileId, "attachment", "wide"));
										break;
									}
								}
							}
						} catch (error) {
							console.error('Error processing mermaid diagram:', error);
						}
					}
					
					if (!codeElement.classList.contains("language-yaml")) {
						builder.addItem(builder.codeBlockItem(codeText));
					}
				}
				break;
			case "P":
				const paragraphDirector = new ParagraphDirector(
					builder,
					this,
					this.app,
					this.client,
					this.settings
				);
				await paragraphDirector.addItems(
					node as HTMLParagraphElement,
					filePath
				);
				break;
			case "OL":
			case "UL":
				const isTaskList =
					node.querySelectorAll("li").length ===
					node.querySelectorAll('input[type="checkbox"]').length;

				const listItems = await Promise.all(
					Array.from(node.children).map(async (li) => {
						const listAdf = new ADFBuilder();
						const listDirector = new ParagraphDirector(
							listAdf,
							this,
							this.app,
							this.client,
							this.settings
						);

						if (isTaskList) {
							return builder.taskItem(
								li.textContent?.trim()!,
								Boolean(li.getAttr("data-task"))
							);
						}

						const p = createEl("p");
						for (const child of Array.from(li.childNodes)) {
							p.append(child);
						}

						await listDirector.addItems(p, filePath);

						return builder.listItem(listAdf.build());
					})
				);

				if (isTaskList) {
					builder.addItem(
						builder.taskListItem(listItems as TaskItemElement[])
					);
					break;
				}

				if (node.nodeName == "OL") {
					builder.addItem(
						builder.orderedListItem(listItems as ListItemElement[])
					);
					break;
				}

				builder.addItem(
					builder.bulletListItem(listItems as ListItemElement[])
				);
				break;

			case "BLOCKQUOTE":
				builder.addItem(builder.blockquoteItem(node.textContent!));
				break;
			case "HR":
				builder.addItem(builder.horizontalRuleItem());
				break;
		}
	}
}
