use std::cell::RefCell;

use oxc::{
	allocator::{Allocator, Vec},
	ast_visit::Visit,
	diagnostics::OxcDiagnostic,
	parser::{ParseOptions, Parser},
	span::SourceType,
};
use thiserror::Error;

pub mod cfg;
mod changes;
mod rewrite;
mod visitor;

use cfg::{Config, Flags, UrlRewriter};
use changes::JsChanges;
use visitor::Visitor;

#[derive(Error, Debug)]
pub enum RewriterError {
	#[error("transformer error: {0}")]
	Transformer(#[from] transform::TransformError),
	#[error("url rewriter error: {0}")]
	Url(Box<dyn std::error::Error + Sync + Send>),
	#[error("formatting error: {0}")]
	Formatting(#[from] std::fmt::Error),

	#[error("oxc panicked in parser: {0}")]
	OxcPanicked(String),
	#[error("Already rewriting")]
	AlreadyRewriting,
	#[error("Not rewriting")]
	NotRewriting,
	#[error("Changes left over")]
	Leftover,
}

#[derive(Debug)]
pub struct RewriteResult<'alloc> {
	pub js: Vec<'alloc, u8>,
	pub sourcemap: Vec<'alloc, u8>,

	pub errors: std::vec::Vec<OxcDiagnostic>,
	pub flags: Flags,
}

pub struct Rewriter {
	changes: RefCell<Option<JsChanges<'static, 'static>>>,
}

impl Rewriter {
	fn take_changes<'alloc: 'data, 'data>(
		&'data self,
		alloc: &'alloc Allocator,
	) -> Result<JsChanges<'alloc, 'data>, RewriterError> {
		let mut slot = self
			.changes
			.try_borrow_mut()
			.map_err(|_| RewriterError::AlreadyRewriting)?;

		let taken = slot.take().ok_or(RewriterError::AlreadyRewriting)?;
		let mut taken = unsafe {
			std::mem::transmute::<JsChanges<'static, 'static>, JsChanges<'alloc, 'data>>(taken)
		};

		match taken.set_alloc(alloc) {
			Ok(()) => Ok(taken),
			Err(error) => {
				drop(taken);
				slot.replace(JsChanges::new());

				Err(error)
			}
		}
	}

	fn put_changes<'alloc: 'data, 'data>(
		&'data self,
		mut changes: JsChanges<'alloc, 'data>,
	) -> Result<(), RewriterError> {
		let mut slot = self
			.changes
			.try_borrow_mut()
			.map_err(|_| RewriterError::AlreadyRewriting)?;

		if slot.is_some() {
			return Err(RewriterError::NotRewriting);
		}

		let detached = if changes.empty() {
			changes.take_alloc()
		} else {
			Err(RewriterError::Leftover)
		};

		match detached {
			Ok(()) => {
				let changes = unsafe {
					std::mem::transmute::<JsChanges<'alloc, 'data>, JsChanges<'static, 'static>>(
						changes,
					)
				};

				slot.replace(changes);

				Ok(())
			}
			Err(error) => {
				drop(changes);
				slot.replace(JsChanges::new());

				Err(error)
			}
		}
	}

	fn discard_changes<'alloc: 'data, 'data>(&'data self, changes: JsChanges<'alloc, 'data>) {
		drop(changes);

		if let Ok(mut slot) = self.changes.try_borrow_mut() {
			if slot.is_none() {
				slot.replace(JsChanges::new());
			}
		}
	}

	pub fn new() -> Self {
		Self {
			changes: RefCell::new(Some(JsChanges::new())),
		}
	}

	pub fn rewrite<'alloc: 'data, 'data, E: UrlRewriter>(
		&'data self,
		alloc: &'alloc Allocator,
		js: &'data str,
		config: Config,
		flags: Flags,
		rewriter: &E,
	) -> Result<RewriteResult<'alloc>, RewriterError> {
		let source_type = SourceType::unambiguous()
			.with_javascript(true)
			.with_module(flags.is_module)
			.with_standard(true);
		let parsed = Parser::new(alloc, js, source_type)
			.with_options(ParseOptions {
				allow_v8_intrinsics: true,
				allow_return_outside_function: true,
				..Default::default()
			})
			.parse();

		if parsed.panicked {
			use std::fmt::Write;

			let mut errors = String::new();
			for error in parsed.errors {
				writeln!(errors, "{error}")?;
			}
			return Err(RewriterError::OxcPanicked(errors));
		}

		let jschanges = self.take_changes(alloc)?;

		let mut visitor = Visitor {
			alloc,
			jschanges,
			error: None,

			config: &config,
			rewriter: rewriter,
			flags,
		};
		visitor.visit_program(&parsed.program);
		if let Some(error) = visitor.error {
			self.discard_changes(visitor.jschanges);

			return Err(RewriterError::Url(error));
		}
		let mut jschanges = visitor.jschanges;

		let performed = jschanges.perform(js, &config, &visitor.flags);
		let changed = match performed {
			Ok(changed) => changed,
			Err(error) => {
				self.discard_changes(jschanges);

				return Err(error);
			}
		};

		self.put_changes(jschanges)?;

		let js: Vec<'alloc, u8> = changed.source;
		let sourcemap: Vec<'alloc, u8> = changed.map;

		Ok(RewriteResult {
			js,
			sourcemap,
			errors: parsed.errors,
			flags: visitor.flags,
		})
	}
}
