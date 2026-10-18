use std::error::Error;

use oxc::allocator::StringBuilder;

pub trait UrlRewriter {
	fn rewrite(
		&self,
		cfg: &Config,
		flags: &Flags,
		url: &str,
		builder: &mut StringBuilder,
		module: bool,
	) -> Result<(), Box<dyn Error + Sync + Send>>;
}

pub struct Config {
	pub prefix: String,

	pub wrapfn: String,
	pub setrealmfn: String,
	pub wrappropertybase: String,
	pub wraplocation: String,
	pub wrapparent: String,
	pub wraptop: String,
	pub wrapeval: String,
	pub wrappropertyfn: String,
	pub cleanrestfn: String,
	pub importfn: String,
	pub rewritefn: String,
	pub wrappostmessagefn: String,
	pub metafn: String,
	pub pushsourcemapfn: String,

	pub trysetfn: String,
	pub templocid: String,
	pub tempunusedid: String,
}

#[derive(Debug)]
pub struct Flags {
	pub base: String,
	pub sourcetag: String,

	pub is_module: bool,
	pub capture_errors: bool,
	pub scramitize: bool,
	pub do_sourcemaps: bool,
	pub disable_computed_wrap: bool,
	pub destructure_rewrites: bool,
}

impl Config {
	pub fn wrapped_property(&self, name: &str) -> Option<&str> {
		let value = match name {
			"location" => &self.wraplocation,
			"parent" => &self.wrapparent,
			"top" => &self.wraptop,
			"eval" => &self.wrapeval,
			_ => return None,
		};
		if value.is_empty() { None } else { Some(value.as_str()) }
	}
}
