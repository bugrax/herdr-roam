// Rewriting session files with perl instead of in the mod.
//
// Mods run in QuickJS on Herdr's own thread: rewriting a 10 MB transcript
// there freezes the window long enough to look broken. perl ships with macOS
// and every common Linux, streams a file line by line, and rewrites 10 MB in
// a few hundredths of a second in its own process. It applies exactly the
// rules paths.js compiles (see `entries`), checked by test/rewrite-perl.test.mjs.
//
// Pure: no herdr imports.

// A path ends at one of these; a Claude folder name may also go on with "-".
// (\x60 is a backtick, which can't appear in this template string.)
export const PERL_REWRITE = String.raw`
use strict; use warnings;
use File::Path qw(make_path); use File::Copy qw(copy); use File::Basename qw(dirname);
my ($rules_file, $manifest) = @ARGV;
my (%to, %dir);
open(my $r, '<:raw', $rules_file) or die "roam: can't read the rules: $!\n";
while (my $l = <$r>) {
  chomp $l;
  my ($f, $t, $k) = split /\t/, $l, -1;
  next unless defined $k;
  $to{$f} = $t; $dir{$f} = ($k eq 'dir');
}
close $r;
my @keys = sort { length($b) <=> length($a) } keys %to;
my $end_path = q#(?=$|[/\\\\"'\x60\s:;,)\]}>|])#;
my $end_dir = q#(?=$|[-/\\\\"'\x60\s:;,)\]}>|])#;
my $alt = join '|', map { quotemeta($_) . ($dir{$_} ? $end_dir : $end_path) } @keys;
my $rx = @keys ? qr/(?<![A-Za-z0-9_.~-])($alt)/ : undef;
my $n = 0;
open(my $m, '<:raw', $manifest) or die "roam: can't read the manifest: $!\n";
while (my $l = <$m>) {
  chomp $l;
  my ($mode, $in, $out) = split /\t/, $l, 3;
  next unless defined $out;
  make_path(dirname($out));
  if ($mode ne 'rewrite' || !$rx) { copy($in, $out) or die "roam: can't copy $in: $!\n"; next; }
  open(my $i, '<:raw', $in) or die "roam: can't read $in: $!\n";
  open(my $o, '>:raw', $out) or die "roam: can't write $out: $!\n";
  while (my $line = <$i>) {
    $line =~ s/$rx/my $t = $to{$1}; $n++ if $t ne $1; $t/ge;
    print $o $line;
  }
  close $i;
  close $o or die "roam: can't write $out: $!\n";
}
print "$n\n";
`;

const safe = (s) => typeof s === "string" && !/[\t\n\r]/.test(s);

/** The rules file perl reads: one "from<TAB>to<TAB>path|dir" line per entry. */
export function rulesText(entries) {
  return entries
    .filter((e) => safe(e.from) && safe(e.to))
    .map((e) => `${e.from}\t${e.to}\t${e.dir ? "dir" : "path"}\n`)
    .join("");
}

/** The manifest perl reads: one "rewrite|copy<TAB>in<TAB>out" line per file. */
export function manifestText(items) {
  return items
    .filter((x) => safe(x.from) && safe(x.out))
    .map((x) => `${x.rewrite ? "rewrite" : "copy"}\t${x.from}\t${x.out}\n`)
    .join("");
}
