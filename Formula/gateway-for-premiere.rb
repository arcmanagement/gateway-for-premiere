class GatewayForPremiere < Formula
  desc "Local CLI and Premiere UXP bridge for revision-checked editing"
  homepage "https://github.com/arcmanagement/gateway-for-premiere"
  url "https://github.com/arcmanagement/gateway-for-premiere/releases/download/v0.1.3/arcmanagement-gateway-for-premiere-0.1.3.tgz"
  sha256 "16ba14e511f51c783e4ac0fd1423e101ee50464142a683e58f0f0e6096702568"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "gateway-for-premiere", shell_output("#{bin}/gateway-for-premiere --help")
  end
end
