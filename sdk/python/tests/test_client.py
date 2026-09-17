import unittest
from chronograph_connectors import Client
from chronograph_connectors.adapters import quantum_counts, qsharp_result

class ClientBounds(unittest.TestCase):
    def test_asset_cursor_and_length_fail_closed(self):
        for page in [
            dict(asset="a",bytes=2,offset=0,data_hex="00",next_offset=0,metadata={}),
            dict(asset="a",bytes=2,offset=0,data_hex="00",next_offset=None,metadata={}),
            dict(asset="a",bytes=2,offset=0,data_hex="bad",next_offset=1,metadata={}),
        ]:
            client=Client("http://127.0.0.1:1","fixture")
            client.call=lambda *args: page
            with self.assertRaises(ValueError): client.read_asset("a")

    def test_pagination_bound_and_repeated_cursor(self):
        client=Client("http://127.0.0.1:1","fixture")
        client.call=lambda *args: {"next_cursor":"repeat"}
        with self.assertRaises(ValueError): list(client.pages("as_of",{"t":"0"}))
        with self.assertRaises(ValueError): list(client.pages("as_of",{"t":"0"},max_pages=1))

    def test_quantum_counts_never_guess_probabilities_or_bit_order(self):
        for value in [-1,0.5,True,2**64]:
            with self.assertRaises(ValueError):
                quantum_counts({"00":value},basis="Z",runtime="fixture",backend="fixture",src=1,dst=2,timestamp_us=0)
        for shots in [[],[[0,1],[1]],[["Zero","One"]]]:
            with self.assertRaises(ValueError): qsharp_result(shots,src=1,dst=2,timestamp_us=0)

if __name__=="__main__": unittest.main()
